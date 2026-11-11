import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

export type CredentialFileErrorCode =
  | "invalid_input"
  | "invalid_operation"
  | "not_configured"
  | "unsafe_path"
  | "unsafe_permissions"
  | "unsupported_filesystem"
  | "file_too_large"
  | "invalid_configuration"
  | "shared_material"
  | "baseline_changed"
  | "operation_conflict"
  | "material_missing"
  | "material_invalid"
  | "io_failure";
export class CredentialFileError extends Error {
  constructor(readonly code: CredentialFileErrorCode) {
    super(code);
    this.name = "CredentialFileError";
  }
}
export type CredentialInput =
  | { platform: "x"; authToken: string; ct0: string }
  | { platform: "pixiv"; refreshToken: string };
export type CredentialPlatform = CredentialInput["platform"];
export interface CredentialMaterial {
  materialRef: string;
  baselineDigest: string;
  targetDigest: string;
  inputDigest: string;
}
type Snapshot = { path: string; bytes: string; identity: string };
type Baseline = { config: Snapshot; cookies: Snapshot[] };
type Material = CredentialMaterial & {
  version: 1;
  platform: CredentialPlatform;
  baseline: Baseline;
  target: string;
};
const FILE_LIMIT = 1024 * 1024;
const MATERIAL_LIMIT = 8 * FILE_LIMIT;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const digest = (baseline: Baseline) => hash(JSON.stringify(baseline));
const metadata = (material: Material): CredentialMaterial => ({
  materialRef: material.materialRef,
  baselineDigest: material.baselineDigest,
  targetDigest: material.targetDigest,
  inputDigest: material.inputDigest,
});

/** Local files only. Callers own authorization, maintenance and per-platform DB
 * serialization. There is no portable filesystem compare-and-swap against an
 * unrelated external writer; exclusive operational ownership remains required.
 * Construct paths from trusted server configuration, never request fields. */
export class ControlledGalleryCredentials {
  private readonly io: typeof fs;
  private readonly stateDirectory: string;
  private readonly configPaths: Partial<Record<CredentialPlatform, string>>;

  constructor(options: {
    stateDirectory: string;
    configPaths: Partial<Record<CredentialPlatform, string>>;
    io?: typeof fs;
  }) {
    this.io = options.io ?? fs;
    this.stateDirectory = options.stateDirectory;
    this.configPaths = { ...options.configPaths };
  }

  protected assertPrivate(info: Stats, directory: boolean): void {
    if (process.platform === "win32")
      throw new CredentialFileError("unsupported_filesystem");
    if (
      (info.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
      info.uid !== process.geteuid?.()
    )
      throw new CredentialFileError("unsafe_permissions");
  }

  protected async syncDirectory(path: string): Promise<void> {
    const handle = await this.io.open(
      path,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CredentialFileError) throw error;
      // Never retain a native fs error/cause: it can include a private path.
      throw new CredentialFileError("io_failure");
    }
  }

  private configPath(platform: CredentialPlatform): string {
    const path = this.configPaths[platform];
    if (!path) throw new CredentialFileError("not_configured");
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new CredentialFileError("unsafe_path");
    return path;
  }

  private operationPath(ref: string): string {
    if (!UUID.test(ref)) throw new CredentialFileError("invalid_operation");
    return join(this.stateDirectory, `${ref.toLowerCase()}.json`);
  }

  private async directory(path: string): Promise<void> {
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new CredentialFileError("unsafe_path");
    // Check every ancestor for path redirects, but require private mode only on
    // the managed directory (system ancestors such as / need not be private).
    let cursor = path;
    while (true) {
      const info = await this.io.lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new CredentialFileError("unsafe_path");
      if (cursor === path) this.assertPrivate(info, true);
      const parent = dirname(cursor);
      if (parent === cursor || cursor === parse(cursor).root) break;
      cursor = parent;
    }
    if ((await this.io.realpath(path)) !== path)
      throw new CredentialFileError("unsafe_path");
  }

  private identity(info: Stats, material = false): string {
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${material ? "immutable" : info.ctimeMs}:${info.mode}:${info.uid}`;
  }

  private async read(
    path: string,
    limit = FILE_LIMIT,
    material = false,
  ): Promise<Snapshot> {
    await this.directory(dirname(path));
    const before = await this.io.lstat(path);
    // Immutable operation publication uses a hardlink followed by unlink. A
    // crash may leave both private names; this must not destroy recoverability.
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      (!material && before.nlink !== 1)
    )
      throw new CredentialFileError("unsafe_path");
    this.assertPrivate(before, false);
    if (before.size > limit) throw new CredentialFileError("file_too_large");
    const handle = await this.io.open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (this.identity(opened, material) !== this.identity(before, material))
        throw new CredentialFileError("baseline_changed");
      const bytes = Buffer.alloc(limit + 1);
      let length = 0;
      while (length <= limit) {
        const result = await handle.read(
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > limit) throw new CredentialFileError("file_too_large");
      const after = await handle.stat();
      const current = await this.io.lstat(path);
      if (
        this.identity(after, material) !== this.identity(opened, material) ||
        this.identity(current, material) !== this.identity(opened, material) ||
        current.isSymbolicLink()
      )
        throw new CredentialFileError("baseline_changed");
      return {
        path,
        bytes: bytes.subarray(0, length).toString("base64"),
        identity: this.identity(after, material),
      };
    } finally {
      await handle.close();
    }
  }

  private json(snapshot: Snapshot): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(snapshot.bytes, "base64").toString("utf8"),
      );
      if (object(parsed)) return parsed;
    } catch {
      /* sanitized below */
    }
    throw new CredentialFileError("invalid_configuration");
  }

  private cookiePaths(config: Snapshot): Set<string> {
    const json = this.json(config);
    const paths = new Set<string>();
    let count = 0;
    const visit = (value: unknown, depth: number): void => {
      if (depth > 12) throw new CredentialFileError("invalid_configuration");
      if (!object(value) && !Array.isArray(value)) return;
      for (const [key, child] of Object.entries(value)) {
        if (++count > 10000)
          throw new CredentialFileError("invalid_configuration");
        if (key === "cookies" && typeof child === "string") {
          if (!isAbsolute(child) || /[$%]/.test(child))
            throw new CredentialFileError("invalid_configuration");
          paths.add(resolve(dirname(config.path), child));
        } else if (key === "cookies-from-browser" && child) {
          throw new CredentialFileError("invalid_configuration");
        } else visit(child, depth + 1);
      }
    };
    visit(json, 0);
    if (paths.size > 4 || paths.has(config.path))
      throw new CredentialFileError("invalid_configuration");
    return paths;
  }

  private async distinctMaterials(
    platform: CredentialPlatform,
    config: Snapshot,
    cookies: Set<string>,
  ): Promise<void> {
    const own = new Set([config.path, ...cookies]);
    for (const otherPlatform of ["x", "pixiv"] as const) {
      if (platform === otherPlatform || !this.configPaths[otherPlatform])
        continue;
      const otherPath = this.configPath(otherPlatform);
      if (own.has(otherPath)) throw new CredentialFileError("shared_material");
      // Only the other bounded JSON is needed; do not load its Cookie content.
      // Fail closed if that configured file cannot establish disjoint ownership.
      const otherConfig = await this.read(otherPath);
      const otherCookies = this.cookiePaths(otherConfig);
      if ([...otherCookies].some((path) => own.has(path)))
        throw new CredentialFileError("shared_material");
    }
  }

  private async baseline(platform: CredentialPlatform): Promise<Baseline> {
    const config = await this.read(this.configPath(platform));
    const paths = this.cookiePaths(config);
    await this.distinctMaterials(platform, config, paths);
    const cookies: Snapshot[] = [];
    let bytes = Buffer.from(config.bytes, "base64").length;
    for (const path of [...paths].sort()) {
      const cookie = await this.read(path);
      bytes += Buffer.from(cookie.bytes, "base64").length;
      if (bytes > 4 * FILE_LIMIT)
        throw new CredentialFileError("file_too_large");
      cookies.push(cookie);
    }
    return { config, cookies };
  }

  private normalize(
    platform: CredentialPlatform,
    input: CredentialInput,
  ): CredentialInput {
    if (!object(input) || input.platform !== platform)
      throw new CredentialFileError("invalid_input");
    const keys =
      platform === "x"
        ? ["platform", "authToken", "ct0"]
        : ["platform", "refreshToken"];
    if (
      Object.keys(input).length !== keys.length ||
      Object.keys(input).some((key) => !keys.includes(key))
    )
      throw new CredentialFileError("invalid_input");
    const value = (key: string): string => {
      const raw: unknown = (input as unknown as Record<string, unknown>)[key];
      if (
        typeof raw !== "string" ||
        raw.length > 8192 ||
        /[\r\n\0]/.test(raw) ||
        !raw.trim()
      )
        throw new CredentialFileError("invalid_input");
      return raw.trim();
    };
    return platform === "x"
      ? { platform, authToken: value("authToken"), ct0: value("ct0") }
      : { platform, refreshToken: value("refreshToken") };
  }

  async inspect(
    platform: CredentialPlatform,
  ): Promise<{ baselineDigest: string }> {
    return this.safe(async () => {
      await this.directory(this.stateDirectory);
      return { baselineDigest: digest(await this.baseline(platform)) };
    });
  }

  private async load(ref: string): Promise<Material> {
    const path = this.operationPath(ref);
    await this.directory(this.stateDirectory);
    let snapshot: Snapshot;
    try {
      snapshot = await this.read(path, MATERIAL_LIMIT, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new CredentialFileError("material_missing");
      throw error;
    }
    let material: Material;
    try {
      material = JSON.parse(
        Buffer.from(snapshot.bytes, "base64").toString("utf8"),
      ) as Material;
    } catch {
      throw new CredentialFileError("material_invalid");
    }
    try {
      if (
        material.version !== 1 ||
        material.materialRef !== ref.toLowerCase() ||
        !["x", "pixiv"].includes(material.platform) ||
        material.baseline.config.path !== this.configPath(material.platform) ||
        !Array.isArray(material.baseline.cookies) ||
        material.baseline.cookies.length > 4 ||
        digest(material.baseline) !== material.baselineDigest ||
        hash(Buffer.from(material.target, "base64")) !==
          material.targetDigest ||
        !/^[a-f0-9]{64}$/.test(material.inputDigest)
      )
        throw new Error();
      if (Buffer.from(material.target, "base64").length > FILE_LIMIT)
        throw new Error();
      // Stored paths are internal, yet still reject forged/redirected materials.
      for (const old of [
        material.baseline.config,
        ...material.baseline.cookies,
      ]) {
        if (
          !isAbsolute(old.path) ||
          resolve(old.path) !== old.path ||
          typeof old.bytes !== "string" ||
          typeof old.identity !== "string" ||
          Buffer.from(old.bytes, "base64").length > FILE_LIMIT
        )
          throw new Error();
      }
    } catch {
      throw new CredentialFileError("material_invalid");
    }
    return material;
  }

  private async writeExclusive(path: string, bytes: Buffer): Promise<void> {
    const handle = await this.io.open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async prepare(
    id: string,
    platform: CredentialPlatform,
    expectedBaseline: string,
    input: CredentialInput,
  ): Promise<CredentialMaterial> {
    return this.safe(async () => {
      const destination = this.operationPath(id);
      const normalized = this.normalize(platform, input);
      const inputDigest = hash(JSON.stringify(normalized));
      if (!/^[a-f0-9]{64}$/.test(expectedBaseline))
        throw new CredentialFileError("invalid_input");
      await this.directory(this.stateDirectory);
      const replay = async () => {
        const existing = await this.load(id);
        if (
          existing.platform !== platform ||
          existing.baselineDigest !== expectedBaseline ||
          existing.inputDigest !== inputDigest
        )
          throw new CredentialFileError("operation_conflict");
        // An earlier publication may have lost its directory-fsync receipt.
        await this.syncDirectory(this.stateDirectory);
        return metadata(existing);
      };
      try {
        return await replay();
      } catch (error) {
        if (
          !(error instanceof CredentialFileError) ||
          error.code !== "material_missing"
        )
          throw error;
      }
      const baseline = await this.baseline(platform);
      if (digest(baseline) !== expectedBaseline)
        throw new CredentialFileError("baseline_changed");
      const config = this.json(baseline.config);
      if (!object(config.extractor))
        throw new CredentialFileError("invalid_configuration");
      const key = platform === "x" ? "twitter" : "pixiv";
      if (!object(config.extractor[key]))
        throw new CredentialFileError("invalid_configuration");
      const extractor = config.extractor[key];
      if (normalized.platform === "x")
        extractor.cookies = {
          auth_token: normalized.authToken,
          ct0: normalized.ct0,
        };
      else extractor["refresh-token"] = normalized.refreshToken;
      const targetBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
      if (targetBytes.length > FILE_LIMIT)
        throw new CredentialFileError("file_too_large");
      const material: Material = {
        version: 1,
        platform,
        materialRef: id.toLowerCase(),
        baselineDigest: expectedBaseline,
        targetDigest: hash(targetBytes),
        inputDigest,
        baseline,
        target: targetBytes.toString("base64"),
      };
      const temporary = join(
        this.stateDirectory,
        `.${id.toLowerCase()}.${randomUUID()}.tmp`,
      );
      try {
        await this.writeExclusive(
          temporary,
          Buffer.from(JSON.stringify(material)),
        );
        try {
          await this.io.link(temporary, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            return await replay();
          throw error;
        }
        // Drop the extra hardlink before material reads enforce nlink === 1.
        await this.io.unlink(temporary);
        await this.syncDirectory(this.stateDirectory);
        return metadata(material);
      } finally {
        await this.io.unlink(temporary).catch(() => undefined);
      }
    });
  }

  private async state(
    material: Material,
  ): Promise<"baseline" | "promoted" | "conflict"> {
    try {
      const config = await this.read(this.configPath(material.platform));
      await this.distinctMaterials(
        material.platform,
        config,
        this.cookiePaths(config),
      );
      const cookies: Snapshot[] = [];
      for (const cookie of material.baseline.cookies)
        cookies.push(await this.read(cookie.path));
      if (JSON.stringify(cookies) !== JSON.stringify(material.baseline.cookies))
        return "conflict";
      if (
        config.bytes === material.target &&
        hash(Buffer.from(config.bytes, "base64")) === material.targetDigest
      )
        return "promoted";
      return digest({ config, cookies }) === material.baselineDigest
        ? "baseline"
        : "conflict";
    } catch {
      return "conflict";
    }
  }

  async recover(
    ref: string,
  ): Promise<
    CredentialMaterial & { state: "baseline" | "promoted" | "conflict" }
  > {
    return this.safe(async () => {
      const material = await this.load(ref);
      return { ...metadata(material), state: await this.state(material) };
    });
  }

  async promote(ref: string): Promise<CredentialMaterial> {
    return this.safe(async () => {
      const material = await this.load(ref);
      await this.syncDirectory(this.stateDirectory);
      const state = await this.state(material);
      if (state === "promoted") {
        // Seeing the renamed bytes does not prove the previous directory flush
        // completed. Explicit replay retries it before issuing a success receipt.
        await this.syncDirectory(dirname(this.configPath(material.platform)));
        return metadata(material);
      }
      if (state !== "baseline")
        throw new CredentialFileError("baseline_changed");
      const target = this.configPath(material.platform);
      const directory = dirname(target);
      const temporary = join(
        directory,
        `.comiku-credentials-${ref.toLowerCase()}-${randomUUID()}.tmp`,
      );
      try {
        await this.writeExclusive(
          temporary,
          Buffer.from(material.target, "base64"),
        );
        // Read all baseline components again after the potentially slow flush.
        if ((await this.state(material)) !== "baseline")
          throw new CredentialFileError("baseline_changed");
        await this.directory(directory);
        await this.io.rename(temporary, target);
        await this.syncDirectory(directory);
        if ((await this.state(material)) !== "promoted")
          throw new CredentialFileError("baseline_changed");
        return metadata(material);
      } finally {
        await this.io.unlink(temporary).catch(() => undefined);
      }
    });
  }
}
