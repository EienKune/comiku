import {
  inspectImage,
  MANUAL_UPLOAD_MAX_EXPANDED_BYTES,
  MANUAL_UPLOAD_MAX_FILE_BYTES,
  MANUAL_UPLOAD_MAX_IMAGES_PER_GROUP,
  orderManualImages,
  type ManualUploadFile,
  type PreparedManualImage,
} from "../candidates/manual-candidate-upload.js";

export const TYPESET_IMAGE_MAX_FILES = MANUAL_UPLOAD_MAX_IMAGES_PER_GROUP;
export const TYPESET_IMAGE_MAX_FILE_BYTES = MANUAL_UPLOAD_MAX_FILE_BYTES;
export const TYPESET_IMAGE_MAX_TOTAL_BYTES = MANUAL_UPLOAD_MAX_EXPANDED_BYTES;

export interface PreparedTypesetImages {
  images: (PreparedManualImage & {
    width: number;
    height: number;
    uploadIndex: number;
  })[];
  automaticallySorted: boolean;
}

export function prepareTypesetImages(
  files: ManualUploadFile[],
): PreparedTypesetImages {
  if (!files.length) throw new Error("请选择至少一张成图");
  if (files.length > TYPESET_IMAGE_MAX_FILES) {
    throw new Error("每个成图版本最多包含 100 张图片");
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > TYPESET_IMAGE_MAX_TOTAL_BYTES) {
    throw new Error("单个成图版本的图片总量不能超过 250 MiB");
  }
  const inspected = files.map((file, uploadIndex) => {
    const image = inspectImage(file.originalname, file.buffer);
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(image.contentType)
    ) {
      throw new Error("成图只支持 PNG、JPEG 或 WebP 图片");
    }
    if (!image.width || !image.height) {
      throw new Error(`无法读取成图尺寸：${file.originalname}`);
    }
    return { ...image, uploadIndex } as PreparedManualImage & {
      width: number;
      height: number;
      uploadIndex: number;
    };
  });
  return orderManualImages(inspected) as PreparedTypesetImages;
}
