import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import sharp from "sharp";

/** Changing any normalization, coefficient or bit rule requires a new version. */
export const FINGERPRINT_RECIPE = "phash64-dct32-white-exif-v1";
export const FINGERPRINT_BYTE_LIMIT = 64 * 1024 * 1024;
export const FINGERPRINT_PIXEL_LIMIT = 40_000_000;
export const SIMILARITY_MAX_DISTANCE = 10;
export const SIMILARITY_RESULT_LIMIT = 12;

export class FingerprintInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Consume the original exactly once, enforcing actual bytes, not just metadata. */
export async function readFingerprintInput(
  stream: Readable,
  signal: AbortSignal,
  limit = FINGERPRINT_BYTE_LIMIT,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => stream.destroy(new FingerprintInputError("read_aborted"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.byteLength;
      if (size > limit) throw new FingerprintInputError("byte_limit");
      chunks.push(data);
    }
    if (!size) throw new FingerprintInputError("empty_image");
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", abort);
    stream.destroy();
  }
}

const cosine = Array.from({ length: 8 }, (_, frequency) =>
  Array.from({ length: 32 }, (_, position) =>
    Math.cos(((2 * position + 1) * frequency * Math.PI) / 64),
  ),
);

/** Orthonormal DCT-II, upper-left 8x8; row-major MSB first, DC always zero.
 * Median is the middle of 63 AC coefficients; ties are zero. Near-zero floating
 * point residuals are snapped at 1e-8 so uniform inputs do not hash platform noise.
 */
export function phash64(pixels: Uint8Array): string {
  if (pixels.length !== 32 * 32) throw new Error("Expected 32x32 grayscale");
  const coefficients: number[] = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 32; y++) {
        let row = 0;
        for (let x = 0; x < 32; x++)
          row += pixels[y * 32 + x]! * cosine[u]![x]!;
        sum += row * cosine[v]![y]!;
      }
      const value =
        (sum * (u === 0 ? Math.SQRT1_2 : 1) * (v === 0 ? Math.SQRT1_2 : 1)) /
        16;
      coefficients.push(Math.abs(value) < 1e-8 ? 0 : value);
    }
  }
  const median = coefficients.slice(1).sort((a, b) => a - b)[31]!;
  let hash = 0n;
  for (let i = 0; i < 64; i++)
    hash = (hash << 1n) | (i > 0 && coefficients[i]! > median ? 1n : 0n);
  return hash.toString(16).padStart(16, "0");
}

export async function fingerprintImage(body: Uint8Array) {
  if (!body.byteLength) throw new FingerprintInputError("empty_image");
  if (body.byteLength > FINGERPRINT_BYTE_LIMIT)
    throw new FingerprintInputError("byte_limit");
  const input = Buffer.from(body);
  const options = {
    limitInputPixels: FINGERPRINT_PIXEL_LIMIT,
    animated: false,
    failOn: "error" as const,
  };
  try {
    const metadata = await sharp(input, options).metadata();
    if (!["jpeg", "png", "webp", "gif"].includes(metadata.format ?? ""))
      throw new FingerprintInputError("unsupported_format");
    if (!metadata.width || !metadata.height)
      throw new FingerprintInputError("invalid_image");
    // First animation frame only; EXIF orientation, sRGB, white alpha composite,
    // grayscale, full-image 32x32 Lanczos3 normalization (no crop).
    const pixels = await sharp(input, options)
      .rotate()
      .toColourspace("srgb")
      .flatten({ background: "white" })
      .greyscale()
      .resize(32, 32, { fit: "fill", kernel: "lanczos3" })
      .timeout({ seconds: 10 })
      .raw()
      .toBuffer();
    const rotated = (metadata.orientation ?? 1) >= 5;
    return {
      sourceSha256: createHash("sha256").update(input).digest("hex"),
      phashHex: phash64(pixels),
      width: rotated ? metadata.height : metadata.width,
      height: rotated ? metadata.width : metadata.height,
    };
  } catch (error) {
    if (error instanceof FingerprintInputError) throw error;
    throw new FingerprintInputError("invalid_image");
  }
}
