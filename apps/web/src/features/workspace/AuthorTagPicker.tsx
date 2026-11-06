import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button } from "../../components/ui";
import { client, unwrap } from "../account/api";
import "./author-tag-picker.css";

import type { AuthorTagChoice } from "./author-tag-selection";
export type { AuthorTagChoice } from "./author-tag-selection";

const normalized = (name: string) =>
  name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

export function AuthorTagPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: AuthorTagChoice[];
  onChange: (next: AuthorTagChoice[]) => void;
  disabled?: boolean;
}) {
  const id = useId(),
    root = useRef<HTMLDivElement>(null),
    composing = useRef(false);
  const [input, setInput] = useState(""),
    [open, setOpen] = useState(false),
    [error, setError] = useState(""),
    [active, setActive] = useState(-1);
  const catalog = useQuery({
    queryKey: ["author-tags"],
    queryFn: async ({ signal }) =>
      unwrap(await client.GET("/api/authors/tags", { signal })),
    enabled: open && !disabled,
    staleTime: 0,
  });
  const selectedNames = new Set(value.map((tag) => normalized(tag.name)));
  const query = normalized(input);
  const available = (catalog.data ?? [])
    .filter(
      (tag) =>
        normalized(tag.name).includes(query) &&
        !selectedNames.has(normalized(tag.name)),
    )
    .slice(0, 20);
  function add(choice?: AuthorTagChoice) {
    if (disabled || !catalog.isSuccess || catalog.isFetching) return;
    const name = (choice?.name ?? input)
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ");
    if (!name) return;
    if ([...name].length > 64) {
      setError("标签最多 64 个字符");
      return;
    }
    if (value.length >= 50) {
      setError("最多添加 50 个标签");
      return;
    }
    if (value.some((tag) => normalized(tag.name) === normalized(name))) {
      setError("该标签已添加");
      return;
    }
    const existing = (catalog.data ?? []).find(
      (tag) => normalized(tag.name) === normalized(name),
    );
    onChange([...value, existing ?? choice ?? { name }]);
    setInput("");
    setActive(-1);
    setError("");
  }
  return (
    <div
      className="ui-field author-tag-picker"
      ref={root}
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !root.current?.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <label className="ui-field__label" htmlFor={id}>
        标签
      </label>
      <div className="author-tag-picker__control">
        {value.length > 0 && (
          <ul className="author-tag-picker__chips" aria-label="已选标签">
            {value.map((tag) => (
              <li key={"id" in tag ? tag.id : normalized(tag.name)}>
                <span>{tag.name}</span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`移除标签 ${tag.name}`}
                  onClick={() =>
                    onChange(value.filter((selected) => selected !== tag))
                  }
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="author-tag-picker__entry">
          <input
            id={id}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open && !disabled}
            aria-controls={`${id}-options`}
            aria-activedescendant={
              open && active >= 0 && available[active]
                ? `${id}-option-${active}`
                : undefined
            }
            autoComplete="off"
            disabled={disabled}
            value={input}
            placeholder="输入标签，回车添加"
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setInput(event.target.value);
              setError("");
              setActive(-1);
              setOpen(true);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (composing.current || event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                add(active >= 0 ? available[active] : undefined);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setOpen(true);
                setActive((index) => Math.min(index + 1, available.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, -1));
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={
              disabled ||
              !input.trim() ||
              !catalog.isSuccess ||
              catalog.isFetching
            }
            onClick={() => add()}
          >
            添加
          </Button>
        </div>
      </div>
      {error && (
        <span className="ui-field__error" role="alert">
          {error}
        </span>
      )}
      {open && !disabled && (
        <div className="author-tag-picker__menu">
          {catalog.isFetching ? (
            <p role="status">正在读取标签…</p>
          ) : catalog.isError ? (
            <p role="alert">
              标签读取失败。
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void catalog.refetch()}
              >
                重试
              </Button>
            </p>
          ) : null}
          <ul id={`${id}-options`} role="listbox" aria-label="已有标签">
            {available.map((tag, index) => (
              <li
                id={`${id}-option-${index}`}
                key={tag.id}
                role="option"
                aria-selected={index === active}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => add(tag)}
              >
                {tag.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
