export interface PreparedManualImage {
  sourceName: string;
  body: Uint8Array;
  contentType: string;
  width: number | null;
  height: number | null;
}

function dimensions(
  body: Uint8Array,
  contentType: string,
): { width: number | null; height: number | null } {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (contentType === "image/png" && body.byteLength >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (contentType === "image/gif" && body.byteLength >= 10) {
    return {
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
    };
  }
  if (contentType === "image/jpeg") {
    let offset = 2;
    while (offset + 8 < body.byteLength) {
      if (body[offset] !== 0xff) break;
      const marker = body[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2);
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker) &&
        offset + 8 < body.byteLength
      ) {
        return {
          width: view.getUint16(offset + 7),
          height: view.getUint16(offset + 5),
        };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (contentType === "image/webp" && body.byteLength >= 30) {
    const chunk = Buffer.from(body.subarray(12, 16)).toString("ascii");
    if (chunk === "VP8X") {
      return {
        width: 1 + body[24] + (body[25] << 8) + (body[26] << 16),
        height: 1 + body[27] + (body[28] << 8) + (body[29] << 16),
      };
    }
    if (chunk === "VP8L" && body[20] === 0x2f) {
      return {
        width: 1 + body[21] + ((body[22] & 0x3f) << 8),
        height:
          1 +
          ((body[22] & 0xc0) >> 6) +
          (body[23] << 2) +
          ((body[24] & 0x0f) << 10),
      };
    }
    if (
      chunk === "VP8 " &&
      body[23] === 0x9d &&
      body[24] === 0x01 &&
      body[25] === 0x2a
    ) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
  }
  return { width: null, height: null };
}

export function inspectImage(
  sourceName: string,
  body: Uint8Array,
): PreparedManualImage {
  if (!body.byteLength || body.byteLength > 25 * 1024 * 1024) {
    throw new Error("图片为空或超过 25 MiB");
  }
  let contentType: string | null = null;
  if (
    body.byteLength >= 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47 &&
    body[4] === 0x0d &&
    body[5] === 0x0a &&
    body[6] === 0x1a &&
    body[7] === 0x0a
  ) {
    contentType = "image/png";
  } else if (
    body.byteLength >= 3 &&
    body[0] === 0xff &&
    body[1] === 0xd8 &&
    body[2] === 0xff
  ) {
    contentType = "image/jpeg";
  } else if (
    body.byteLength >= 6 &&
    ["GIF87a", "GIF89a"].includes(
      Buffer.from(body.subarray(0, 6)).toString("ascii"),
    )
  ) {
    contentType = "image/gif";
  } else if (
    body.byteLength >= 12 &&
    Buffer.from(body.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(body.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    contentType = "image/webp";
  }
  if (!contentType) throw new Error("只支持有效的 PNG、JPEG、WebP 或 GIF 图片");
  return { sourceName, body, contentType, ...dimensions(body, contentType) };
}
