type Dimensions = { width: number; height: number };
const dimensions = new WeakMap<File, Promise<Dimensions>>();

/** The same immutable File is decoded once for local preview and transfer. */
export function typesetImageDimensions(file: File): Promise<Dimensions> {
  const previous = dimensions.get(file);
  if (previous) return previous;
  const pending = readDimensions(file)
    .then((result) => {
      if (
        ![result.width, result.height].every(
          (value) =>
            Number.isSafeInteger(value) && value > 0 && value <= 2147483647,
        )
      )
        throw new Error(`${file.name}：无法读取有效图片尺寸`);
      return result;
    })
    .catch((error: unknown) => {
      dimensions.delete(file);
      throw error;
    });
  dimensions.set(file, pending);
  return pending;
}

async function readDimensions(file: File): Promise<Dimensions> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<Dimensions>((resolve, reject) => {
      const image = new Image();
      image.onload = () =>
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error(`${file.name}：图片无法解析`));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
