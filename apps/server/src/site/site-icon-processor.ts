import { BadRequestException, PayloadTooLargeException } from "@nestjs/common";
import sharp from "sharp";

export const SITE_ICON_MAX_BYTES = 5 * 1024 * 1024;
export async function processSiteIcon(
  bytes: Uint8Array,
  contentType: string,
): Promise<Record<32 | 256, Buffer>> {
  if (!bytes.byteLength || bytes.byteLength > SITE_ICON_MAX_BYTES)
    throw new PayloadTooLargeException("图标应为非空图片，且不超过 5 MiB");
  const formats: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/webp": "webp",
  };
  try {
    const options = {
      limitInputPixels: 4_000_000,
      animated: false,
      failOn: "error" as const,
    };
    const metadata = await sharp(bytes, options).metadata();
    if (
      !formats[contentType] ||
      metadata.format !== formats[contentType] ||
      (metadata.pages ?? 1) > 1
    )
      throw new Error();
    const render = (size: number) =>
      sharp(bytes, options)
        .rotate()
        .resize(size, size, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
    return { 256: await render(256), 32: await render(32) };
  } catch {
    throw new BadRequestException(
      "请选择不超过四百万像素的静态 PNG、JPEG 或 WebP 图片",
    );
  }
}
