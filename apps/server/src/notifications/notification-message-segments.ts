/** Internal frozen payload. User-provided text is never parsed as CQ code. */
export type NotificationMessageSegment =
  | { type: "text"; data: { text: string } }
  | { type: "at"; data: { qq: string } };

export type NotificationMessagePolicy = "standard" | "work_digest";

/** Local request resource budget, not a OneBot task or mention limit. */
export const NOTIFICATION_MESSAGE_PAYLOAD_MAX_BYTES = 256 * 1024;
const messageJsonMaxBytes = NOTIFICATION_MESSAGE_PAYLOAD_MAX_BYTES - 128;
const textJsonOverhead = Buffer.byteLength('{"type":"text","data":{"text":}}');
const atJsonOverhead = Buffer.byteLength('{"type":"at","data":{"qq":}}');

/** Count JSON's escaped UTF-8 representation without allocating a serialized string. */
function jsonStringBytes(value: string, maximum: number): number | null {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    )
      bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    if (bytes > maximum) return null;
  }
  return bytes <= maximum ? bytes : null;
}

function codePointCount(value: string, maximum: number): number | null {
  let characters = 0;
  for (let index = 0; index < value.length; index++) {
    if (++characters > maximum) return null;
    if (value.codePointAt(index)! > 0xffff) index++;
  }
  return characters;
}

export function notificationMessageTextValid(
  text: unknown,
  policy: NotificationMessagePolicy = "standard",
): text is string {
  if (typeof text !== "string" || !text) return false;
  if (policy === "work_digest")
    return (
      jsonStringBytes(text, messageJsonMaxBytes - textJsonOverhead - 2) !== null
    );
  if (policy !== "standard") return false;
  return codePointCount(text, 1000) !== null;
}

/** Deliberately narrower than OneBot: no at-all, files, URLs or extension keys. */
export function notificationMessageSegments(
  value: unknown,
  policy: NotificationMessagePolicy = "standard",
): NotificationMessageSegment[] | null {
  if (
    !Array.isArray(value) ||
    !value.length ||
    (policy !== "standard" && policy !== "work_digest") ||
    (policy === "standard" && value.length > 20)
  )
    return null;
  const result: NotificationMessageSegment[] = [];
  let characters = 0;
  let bytes = 2;
  let hasText = false;
  const mentions = new Set<string>();
  for (const part of value) {
    if (
      !part ||
      typeof part !== "object" ||
      Object.keys(part).sort().join(",") !== "data,type" ||
      !part.data ||
      typeof part.data !== "object" ||
      Array.isArray(part.data)
    )
      return null;
    if (part.type === "text") {
      if (
        Object.keys(part.data).join(",") !== "text" ||
        typeof part.data.text !== "string"
      )
        return null;
      hasText ||= Boolean(part.data.text.length);
      if (policy === "standard") {
        const count = codePointCount(part.data.text, 1000 - characters);
        if (count === null) return null;
        characters += count;
      } else {
        const textBytes = jsonStringBytes(
          part.data.text,
          messageJsonMaxBytes -
            bytes -
            textJsonOverhead -
            Number(result.length > 0),
        );
        if (textBytes === null) return null;
        bytes += textJsonOverhead + textBytes + Number(result.length > 0);
      }
      result.push({ type: "text", data: { text: part.data.text } });
    } else if (part.type === "at") {
      if (
        Object.keys(part.data).join(",") !== "qq" ||
        typeof part.data.qq !== "string" ||
        !/^[1-9][0-9]{4,19}$/.test(part.data.qq) ||
        mentions.has(part.data.qq)
      )
        return null;
      mentions.add(part.data.qq);
      if (policy === "standard" && mentions.size > 5) return null;
      if (policy === "work_digest") {
        bytes +=
          atJsonOverhead + part.data.qq.length + 2 + Number(result.length > 0);
        if (bytes > messageJsonMaxBytes) return null;
      }
      result.push({ type: "at", data: { qq: part.data.qq } });
    } else return null;
  }
  return hasText ? result : null;
}
