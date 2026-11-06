export function canonicalXHandle(input: string): string {
  let value = input.trim().replace(/^@/, "");
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (
      !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
        url.hostname.toLowerCase(),
      )
    )
      throw new Error("请输入有效的 X @账号或主页地址");
    value = url.pathname.split("/").filter(Boolean)[0] ?? "";
  }
  if (!/^[A-Za-z0-9_]{1,15}$/.test(value))
    throw new Error("请输入有效的 X @账号或主页地址");
  return value;
}
