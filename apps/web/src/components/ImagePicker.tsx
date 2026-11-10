import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FileArchive, ImagePlus, X } from "lucide-react";
import { Button, IconButton } from "./ui";
import "./image-picker.css";

const accept = "image/png,image/jpeg,image/webp";
const fileKey = (file: File) =>
  `${file.name}:${file.size}:${file.lastModified}`;

function LocalImage({ file, fallback }: { file: File; fallback?: ReactNode }) {
  const ref = useRef<HTMLImageElement>(null);
  const [failedFile, setFailedFile] = useState<File | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    if (ref.current) ref.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return failedFile === file && fallback ? (
    fallback
  ) : (
    <img ref={ref} alt={file.name} onError={() => setFailedFile(file)} />
  );
}

export function ImagePicker({
  label,
  files,
  onChange,
  multiple = false,
  disabled = false,
  maxFiles = multiple ? 10 : 1,
  maxFileSize = 10 * 1024 * 1024,
  variant = "default",
  currentAvatar,
  avatarField,
  avatarFallback,
  selectionStatus = "头像未保存",
  formats = "images",
}: {
  label: string;
  files: File[];
  onChange: (files: File[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
  variant?: "default" | "avatar";
  currentAvatar?: ReactNode;
  avatarField?: ReactNode;
  avatarFallback?: ReactNode;
  selectionStatus?: string;
  formats?: "images" | "source";
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [error, setError] = useState("");
  const sourceFiles = formats === "source";
  const noun = sourceFiles ? "文件" : "图片";
  const sizeLimit = `${maxFileSize / 1024 / 1024} MiB`;
  return (
    <fieldset className={`ui-image-picker ui-image-picker--${variant}`}>
      <legend>{label}</legend>
      <input
        ref={input}
        type="file"
        hidden
        aria-label={label}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
        accept={
          sourceFiles
            ? ".zip,image/png,image/jpeg,image/webp,image/gif"
            : accept
        }
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => {
          const selected = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (disabled || !selected.length) return;
          if (
            selected.some(
              (file) =>
                !(
                  sourceFiles
                    ? /\.(zip|png|jpe?g|webp|gif)$/i
                    : /\.(png|jpe?g|webp)$/i
                ).test(file.name),
            )
          ) {
            setError(
              sourceFiles
                ? "请选择图片或 ZIP 文件"
                : "请选择 PNG、JPEG 或 WebP 图片",
            );
            return;
          }
          if (selected.some((file) => file.size > maxFileSize)) {
            setError(`每个${noun}不能超过 ${sizeLimit}`);
            return;
          }
          const next = multiple
            ? [
                ...new Map(
                  [...files, ...selected].map((file) => [fileKey(file), file]),
                ).values(),
              ]
            : selected.slice(0, 1);
          if (next.length > maxFiles) {
            setError(`最多选择 ${maxFiles} 个${noun}`);
            return;
          }
          setError("");
          onChange(next);
        }}
      />
      {variant === "avatar" ? (
        <div
          className={`ui-image-picker__avatar-row${avatarField ? " ui-image-picker__avatar-row--field" : ""}`}
        >
          <button
            type="button"
            className="ui-image-picker__avatar-button"
            disabled={disabled}
            aria-label={`更换${label}`}
            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
            title={`更换${label}`}
            onClick={() => input.current?.click()}
          >
            {files[0] ? (
              <LocalImage
                key={fileKey(files[0])}
                file={files[0]}
                fallback={avatarFallback}
              />
            ) : (
              currentAvatar
            )}
          </button>
          {avatarField}
          {!!files.length && (
            <div className="ui-image-picker__avatar-selection">
              <span role="status">{selectionStatus}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                aria-label={`取消选择${label}`}
                onClick={() => {
                  if (disabled) return;
                  setError("");
                  onChange([]);
                }}
              >
                取消选择
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="ui-image-picker__controls">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            leadingIcon={<ImagePlus size={16} aria-hidden="true" />}
            aria-label={`${files.length ? (multiple ? "添加" : "更换") : "选择"}${label}`}
            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
            onClick={() => input.current?.click()}
          >
            {files.length
              ? multiple
                ? `添加${noun}`
                : `更换${noun}`
              : `选择${noun}`}
          </Button>
          <small id={`${id}-hint`}>
            {sourceFiles ? "图片或 ZIP" : "PNG、JPEG、WebP"} ·{" "}
            {multiple ? `最多 ${maxFiles} 个 · ` : ""}每个 {sizeLimit}
          </small>
        </div>
      )}
      {variant === "avatar" && (
        <small id={`${id}-hint`} className="ui-image-picker__avatar-hint">
          PNG、JPEG、WebP · 每张 {sizeLimit}
        </small>
      )}
      {variant !== "avatar" && !!files.length && (
        <ul className="ui-image-picker__files">
          {files.map((file) => (
            <li key={fileKey(file)}>
              {sourceFiles && /\.zip$/i.test(file.name) ? (
                <FileArchive size={28} aria-hidden="true" />
              ) : (
                <LocalImage file={file} />
              )}
              <span className="ui-image-picker__name" title={file.name}>
                {file.name}
              </span>
              <IconButton
                type="button"
                label={`移除 ${file.name}`}
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  setError("");
                  onChange(files.filter((item) => item !== file));
                }}
              >
                <X size={16} aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p id={`${id}-error`} className="ui-image-picker__error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
