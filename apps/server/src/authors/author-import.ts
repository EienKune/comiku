export const AUTHOR_IMPORT_COLUMNS = [
  "display_name",
  "source_language",
  "authorization_status",
  "tags",
  "x_handle",
  "x_user_id",
  "pixiv_user_id",
  "pixiv_profile_url",
] as const;

export const AUTHOR_IMPORT_TEMPLATE = `\uFEFF${AUTHOR_IMPORT_COLUMNS.join(",")}\r\n`;

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      if (field) throw new Error("CSV 引号位置无效");
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n") {
      record.push(field.replace(/\r$/, ""));
      records.push(record);
      record = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV 存在未闭合引号");
  if (field || record.length) {
    record.push(field.replace(/\r$/, ""));
    records.push(record);
  }
  return records;
}

export interface ParsedAuthorImportRow {
  row: number;
  displayName: string;
  sourceLanguage: string;
  authorizationStatus: string;
  tagNames: string[];
  xHandle: string | null;
  xExternalUserId: string | null;
  xDisplayName: string | null;
  xProfileUrl: string | null;
  xAvatarFileObjectId: string | null;
  xProfileSyncAdapter: string | null;
  xProfileSyncedAt: string | null;
  pixivUserId: string | null;
  pixivProfileUrl: string | null;
}

export function parseAuthorImportCsv(
  body: Uint8Array,
): ParsedAuthorImportRow[] {
  if (!body.byteLength) throw new Error("CSV 文件为空");
  if (body.byteLength > 1024 * 1024) throw new Error("CSV 文件不能超过 1 MiB");
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(body)
    .replace(/^\uFEFF/, "");
  const records = parseCsvRecords(text);
  if (!records.length) throw new Error("CSV 文件为空");
  if (
    records[0].length !== AUTHOR_IMPORT_COLUMNS.length ||
    records[0].some(
      (value, index) => value.trim() !== AUTHOR_IMPORT_COLUMNS[index],
    )
  ) {
    throw new Error("CSV 列与当前模板不一致，请重新下载模板");
  }
  if (records.length > 501) throw new Error("每次最多导入 500 位作者");
  return records
    .slice(1)
    .filter((record) => record.some((value) => value.trim()))
    .map((record, index) => {
      if (record.length !== AUTHOR_IMPORT_COLUMNS.length) {
        throw new Error(`第 ${index + 2} 行列数不正确`);
      }
      const [
        displayName,
        sourceLanguage,
        authorizationStatus,
        tags,
        xHandle,
        xExternalUserId,
        pixivUserId,
        pixivProfileUrl,
      ] = record.map((value) => value.trim());
      return {
        row: index + 2,
        displayName,
        sourceLanguage,
        authorizationStatus,
        tagNames: tags
          .split(/[|｜]/)
          .map((value) => value.trim())
          .filter(Boolean),
        xHandle: xHandle || null,
        xExternalUserId: xExternalUserId || null,
        xDisplayName: null,
        xProfileUrl: null,
        xAvatarFileObjectId: null,
        xProfileSyncAdapter: null,
        xProfileSyncedAt: null,
        pixivUserId: pixivUserId || null,
        pixivProfileUrl: pixivProfileUrl || null,
      };
    });
}
