/** Internal frozen payload. User-provided text is never parsed as CQ code. */
export type NotificationMessageSegment =
  | { type: "text"; data: { text: string } }
  | { type: "at"; data: { qq: string } };

/** Deliberately narrower than OneBot: no at-all, files, URLs or extension keys. */
export function notificationMessageSegments(
  value: unknown,
): NotificationMessageSegment[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 20) return null;
  const result: NotificationMessageSegment[] = [];
  let characters = 0;
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
      characters += [...part.data.text].length;
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
      result.push({ type: "at", data: { qq: part.data.qq } });
    } else return null;
  }
  return characters > 0 && characters <= 1000 && mentions.size <= 5
    ? result
    : null;
}
