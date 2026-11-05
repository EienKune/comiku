import { useEffect, useId, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { Button, IconButton } from "./ui";
import "./image-picker.css";

const accept = "image/png,image/jpeg,image/webp";
const fileKey = (file: File) =>
  `${file.name}:${file.size}:${file.lastModified}`;

function LocalImage({ file }: { file: File }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    if (ref.current) ref.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <img ref={ref} alt={file.name} />;
}

export function ImagePicker({
  label,
  files,
  onChange,
  multiple = false,
  disabled = false,
  maxFiles = multiple ? 10 : 1,
  maxFileSize = 10 * 1024 * 1024,
}: {
  label: string;
  files: File[];
  onChange: (files: File[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [error, setError] = useState("");
  const sizeLimit = `${maxFileSize / 1024 / 1024} MiB`;
  return (
    <fieldset className="ui-image-picker" disabled={disabled}>
      <legend>{label}</legend>
      <input
        ref={input}
        type="file"
        hidden
        aria-label={label}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => {
          const selected = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (disabled || !selected.length) return;
          if (
            selected.some((file) => !/\.(png|jpe?g|webp)$/i.test(file.name))
          ) {
            setError("请选择 PNG、JPEG 或 WebP 图片");
            return;
          }
          if (selected.some((file) => file.size > maxFileSize)) {
            setError(`每张图片不能超过 ${sizeLimit}`);
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
            setError(`最多选择 ${maxFiles} 张图片`);
            return;
          }
          setError("");
          onChange(next);
        }}
      />
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
          {files.length ? (multiple ? "添加图片" : "更换图片") : "选择图片"}
        </Button>
        <small id={`${id}-hint`}>
          PNG、JPEG、WebP · {multiple ? `最多 ${maxFiles} 张 · ` : ""}每张{" "}
          {sizeLimit}
        </small>
      </div>
      {!!files.length && (
        <ul className="ui-image-picker__files">
          {files.map((file) => (
            <li key={fileKey(file)}>
              <LocalImage file={file} />
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
