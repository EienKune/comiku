import sharp from "sharp";

export const THUMBNAIL_RECIPE = "webp-800-q82-v1";
export const IMAGE_PIXEL_LIMIT = 40_000_000;
sharp.cache({ memory: 32, files: 0, items: 20 });
sharp.concurrency(1);

export function shouldKeepThumbnail(originalSize: number, outputSize: number) {
  return outputSize <= originalSize * 0.8;
}

export async function generateThumbnail(body: Uint8Array) {
  const original = await sharp(body, {
    limitInputPixels: IMAGE_PIXEL_LIMIT,
    animated: false,
  }).metadata();
  const { data, info } = await sharp(body, {
    limitInputPixels: IMAGE_PIXEL_LIMIT,
    animated: false,
    failOn: "error",
  })
    .rotate()
    .resize({
      width: 800,
      height: 800,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 82, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  return {
    body: data,
    width: shouldKeepThumbnail(body.byteLength, data.byteLength)
      ? info.width
      : original.width!,
    height: shouldKeepThumbnail(body.byteLength, data.byteLength)
      ? info.height
      : original.height!,
    keep: shouldKeepThumbnail(body.byteLength, data.byteLength),
  };
}
