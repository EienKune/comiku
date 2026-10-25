const byteLimit = 2 * 1024 * 1024;
const fileLimit = 2_000;
const markerLimit = 20_000;
const translationLengthLimit = 100_000;
const sectionPattern = /^>{8}\[([^\]\r\n]+)]<{8}$/;
const numberPattern = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const markerPattern = new RegExp(
  `^-{16}\\[(\\d+)]-{16}\\[(${numberPattern}),(${numberPattern}),([+-]?\\d+)]$`,
);

export const defaultLabelPlusHeader = [
  "1,0",
  "-",
  "框内",
  "框外",
  "-",
  "Default Comment",
  " You can edit me",
] as const;

export interface LabelPlusMarker {
  x: number;
  y: number;
  positionType: number;
  translation: string;
}

export interface LabelPlusImage {
  fileName: string;
  markers: LabelPlusMarker[];
}

export interface LabelPlusDocument {
  formatVersion: string;
  headerLines: string[];
  images: LabelPlusImage[];
}

export interface LabelPlusWarning {
  code:
    | "duplicate_image_name"
    | "non_sequential_marker_number"
    | "unsupported_position_type";
  line: number;
  message: string;
}

export interface LabelPlusParseResult {
  document: LabelPlusDocument;
  warnings: LabelPlusWarning[];
}

export class LabelPlusParseError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line ? `第 ${line} 行：${message}` : message);
    this.name = "LabelPlusParseError";
  }
}

function inputText(input: string | Uint8Array) {
  const size =
    typeof input === "string"
      ? new TextEncoder().encode(input).byteLength
      : input.byteLength;
  if (size > byteLimit) throw new LabelPlusParseError("文件超过 2 MiB 限制");
  try {
    return typeof input === "string"
      ? input
      : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new LabelPlusParseError("文件不是有效的 UTF-8 文本");
  }
}

function normalizedLines(input: string | Uint8Array) {
  const text = inputText(input).replace(/^\uFEFF/, "");
  if (text.includes("\0")) throw new LabelPlusParseError("文件包含空字节");
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function parseCoordinate(value: string, line: number, axis: "x" | "y") {
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1) {
    throw new LabelPlusParseError(`${axis} 坐标必须是 0 到 1 之间的数值`, line);
  }
  return coordinate;
}

export function parseLabelPlus(
  input: string | Uint8Array,
): LabelPlusParseResult {
  const lines = normalizedLines(input);
  const firstSection = lines.findIndex((line) => sectionPattern.test(line));
  if (firstSection < 0) throw new LabelPlusParseError("未找到图片章节");

  const headerLines = lines.slice(0, firstSection);
  while (headerLines.at(-1) === "") headerLines.pop();
  const formatVersion = headerLines[0];
  if (!formatVersion || !/^\d+,\d+$/.test(formatVersion)) {
    throw new LabelPlusParseError("文件头缺少有效格式版本", 1);
  }
  if (formatVersion !== "1,0") {
    throw new LabelPlusParseError(`暂不支持 LabelPlus ${formatVersion}`, 1);
  }

  const images: LabelPlusImage[] = [];
  const warnings: LabelPlusWarning[] = [];
  const imageNames = new Set<string>();
  let currentImage: LabelPlusImage | undefined;
  let currentMarker: LabelPlusMarker | undefined;
  let translationLines: string[] = [];
  let markerCount = 0;

  const finishMarker = () => {
    if (!currentMarker) return;
    if (translationLines.at(-1) === "") translationLines.pop();
    currentMarker.translation = translationLines.join("\n");
    if (currentMarker.translation.length > translationLengthLimit) {
      throw new LabelPlusParseError("单条译文超过 100,000 字符限制");
    }
    currentMarker = undefined;
    translationLines = [];
  };

  for (let index = firstSection; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const section = sectionPattern.exec(line);
    if (section) {
      finishMarker();
      const fileName = section[1];
      if (imageNames.has(fileName)) {
        warnings.push({
          code: "duplicate_image_name",
          line: lineNumber,
          message: `图片文件名重复：${fileName}`,
        });
      }
      imageNames.add(fileName);
      currentImage = { fileName, markers: [] };
      images.push(currentImage);
      if (images.length > fileLimit) {
        throw new LabelPlusParseError("图片章节超过 2,000 个", lineNumber);
      }
      continue;
    }

    const marker = markerPattern.exec(line);
    if (marker) {
      if (!currentImage) {
        throw new LabelPlusParseError("标记出现在图片章节之前", lineNumber);
      }
      finishMarker();
      const displayedNumber = Number(marker[1]);
      const expectedNumber = currentImage.markers.length + 1;
      if (displayedNumber !== expectedNumber) {
        warnings.push({
          code: "non_sequential_marker_number",
          line: lineNumber,
          message: `标记显示序号 ${displayedNumber} 将按顺序归一为 ${expectedNumber}`,
        });
      }
      const positionType = Number(marker[4]);
      if (positionType !== 1 && positionType !== 2) {
        warnings.push({
          code: "unsupported_position_type",
          line: lineNumber,
          message: `标记类型 ${positionType} 暂无内部语义映射`,
        });
      }
      currentMarker = {
        x: parseCoordinate(marker[2], lineNumber, "x"),
        y: parseCoordinate(marker[3], lineNumber, "y"),
        positionType,
        translation: "",
      };
      currentImage.markers.push(currentMarker);
      markerCount += 1;
      if (markerCount > markerLimit) {
        throw new LabelPlusParseError("标记超过 20,000 个", lineNumber);
      }
      continue;
    }

    if (currentMarker) {
      translationLines.push(line);
    } else if (line !== "") {
      throw new LabelPlusParseError("图片章节中出现无法识别的内容", lineNumber);
    }
  }
  finishMarker();
  return {
    document: { formatVersion, headerLines, images },
    warnings,
  };
}

function validateDocument(document: LabelPlusDocument) {
  if (document.formatVersion !== "1,0") {
    throw new LabelPlusParseError(
      `暂不支持 LabelPlus ${document.formatVersion}`,
    );
  }
  if (!document.images.length)
    throw new LabelPlusParseError("至少需要一张图片");
  if (document.images.length > fileLimit) {
    throw new LabelPlusParseError("图片章节超过 2,000 个");
  }
}

export function serializeLabelPlus(document: LabelPlusDocument) {
  validateDocument(document);
  const lines = [...document.headerLines];
  while (lines.at(-1) === "") lines.pop();
  if (lines[0] !== document.formatVersion) {
    throw new LabelPlusParseError("文件头版本与格式版本不一致");
  }
  let markerCount = 0;
  for (const image of document.images) {
    if (!image.fileName || /[\]\r\n]/.test(image.fileName)) {
      throw new LabelPlusParseError("图片文件名为空或包含非法字符");
    }
    lines.push("", `>>>>>>>>[${image.fileName}]<<<<<<<<`);
    for (const [index, marker] of image.markers.entries()) {
      markerCount += 1;
      if (markerCount > markerLimit) {
        throw new LabelPlusParseError("标记超过 20,000 个");
      }
      const x = parseCoordinate(String(marker.x), 0, "x").toFixed(3);
      const y = parseCoordinate(String(marker.y), 0, "y").toFixed(3);
      if (!Number.isInteger(marker.positionType)) {
        throw new LabelPlusParseError("标记类型必须是整数");
      }
      if (marker.translation.length > translationLengthLimit) {
        throw new LabelPlusParseError("单条译文超过 100,000 字符限制");
      }
      const translationLines = marker.translation
        .replace(/\r\n?/g, "\n")
        .split("\n");
      if (
        translationLines.some(
          (line) => sectionPattern.test(line) || markerPattern.test(line),
        )
      ) {
        throw new LabelPlusParseError("译文包含无法转义的结构标记行");
      }
      lines.push(
        "",
        `----------------[${index + 1}]----------------[${x},${y},${marker.positionType}]`,
        ...translationLines,
      );
    }
  }
  const output = `\uFEFF${lines.join("\r\n").replace(/(?:\r\n)+$/, "\r\n")}`;
  if (new TextEncoder().encode(output).byteLength > byteLimit) {
    throw new LabelPlusParseError("导出文件超过 2 MiB 限制");
  }
  return output;
}

export function encodeLabelPlus(document: LabelPlusDocument) {
  return new TextEncoder().encode(serializeLabelPlus(document));
}
