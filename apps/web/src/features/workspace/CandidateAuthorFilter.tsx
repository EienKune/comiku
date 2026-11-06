import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { Button, SearchField } from "../../components/ui";
import { client, unwrap } from "../account/api";
import "./author-picker.css";
import "./candidate-author-filter.css";
export type CandidateAuthorChoice = Pick<
  components["schemas"]["AuthorDto"],
  "id" | "displayName"
>;
export function CandidateAuthorFilter({
  value,
  onChange,
}: {
  value: CandidateAuthorChoice | null;
  onChange: (value: CandidateAuthorChoice | null) => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    id = useId();
  const [open, setOpen] = useState(false),
    [input, setInput] = useState(""),
    [term, setTerm] = useState(""),
    [active, setActive] = useState(-1);
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(input.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [input]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const query = useInfiniteQuery({
    queryKey: ["authors", "candidate-filter", term],
    enabled: open,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await client.GET("/api/authors", {
          params: {
            query: {
              limit: 50,
              ...(term ? { search: term } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 15_000,
  });
  const waiting = input.trim() !== term;
  const rows = useMemo(
    () =>
      waiting
        ? []
        : [
            ...new Map(
              (query.data?.pages.flatMap((page) => page.items) ?? []).map(
                (item) => [item.id, item],
              ),
            ).values(),
          ],
    [query.data, waiting],
  );
  useEffect(() => {
    if (open && rows[active])
      document
        .getElementById(`${id}-${rows[active].id}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [active, id, open, rows]);
  function choose(item: CandidateAuthorChoice) {
    onChange({ id: item.id, displayName: item.displayName });
    setOpen(false);
    setInput("");
    setActive(-1);
  }
  return (
    <div
      ref={root}
      className="candidate-author-filter"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setOpen(false);
      }}
    >
      <SearchField
        aria-label="搜索并选择作者"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={
          open && rows[active] ? `${id}-${rows[active].id}` : undefined
        }
        placeholder="搜索并选择作者"
        value={open ? input : (value?.displayName ?? "")}
        maxLength={100}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setInput(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            setActive(-1);
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            if (rows.length)
              setActive((index) =>
                event.key === "ArrowDown"
                  ? Math.min(index + 1, rows.length - 1)
                  : Math.max(index - 1, 0),
              );
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (open && rows[active]) choose(rows[active]);
          }
        }}
      />
      {(value || input) && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange(null);
            setInput("");
            setTerm("");
            setActive(-1);
            setOpen(false);
          }}
        >
          清除作者
        </Button>
      )}
      {open && (
        <div className="candidate-author-filter__menu">
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label="作者搜索建议"
            className="author-picker__results"
            aria-busy={waiting || query.isFetching}
          >
            {rows.map((item, index) => (
              <button
                type="button"
                role="option"
                tabIndex={-1}
                id={`${id}-${item.id}`}
                className="author-picker__option"
                aria-selected={active === index}
                key={item.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(item)}
              >
                <span>{item.displayName}</span>
                <small>
                  {item.externalAccounts
                    .slice(0, 2)
                    .map((account) =>
                      account.platform === "x"
                        ? `X @${account.handle ?? account.externalUserId}`
                        : `Pixiv ${account.externalUserId}`,
                    )
                    .join(" · ")}
                </small>
              </button>
            ))}
          </div>
          {waiting || query.isPending ? (
            <p role="status">正在搜索…</p>
          ) : query.isError ? (
            <p role="alert">
              {query.error.message}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void query.refetch()}
              >
                重试
              </Button>
            </p>
          ) : !rows.length ? (
            <p role="status">没有匹配的作者</p>
          ) : null}
          {!waiting && query.hasNextPage && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              继续加载作者
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
