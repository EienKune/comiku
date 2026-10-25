import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { HttpException } from "@nestjs/common";

let running = 0;
async function derive(password: string, salt: string): Promise<Buffer> {
  if (running >= 2) throw new HttpException("密码校验繁忙，请稍后重试", 429);
  running += 1;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        64,
        { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 },
        (error, key) => {
          if (error) reject(error);
          else resolve(key);
        },
      );
    });
  } finally {
    running -= 1;
  }
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const [version, salt, key, extra] = hash.split("$");
  if (
    version !== "scrypt-v1" ||
    !/^[a-f0-9]{32}$/.test(salt ?? "") ||
    !/^[a-f0-9]{128}$/.test(key ?? "") ||
    extra
  ) {
    await derive(password, "00000000000000000000000000000000");
    return false;
  }
  return timingSafeEqual(await derive(password, salt), Buffer.from(key, "hex"));
}
export const randomCredential = () => randomBytes(24).toString("base64url");
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const normalizeUsername = (value: string) => value.trim().toLowerCase();
