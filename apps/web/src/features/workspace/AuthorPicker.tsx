import { useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { Button, SearchField } from "../../components/ui";
import { client, unwrap } from "../account/api";
import "./author-picker.css";

type Author = components["schemas"]["AuthorDto"];
export function AuthorPicker({
  value,
  onValueChange,
  label = "授权作者",
  autoSelectFirst = false,
  disabled = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  label?: string;
  autoSelectFirst?: boolean;
  disabled?: boolean;
}) {
  const cache = useQueryClient();
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [revoked, setRevoked] = useState(false);
  const autoSelected = useRef(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const authors = useInfiniteQuery({
    queryKey: ["authors", "picker", "authorized", term],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await client.GET("/api/authors", {
          params: {
            query: {
              authorizationStatus: "authorized",
              limit: 50,
              ...(term ? { search: term } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 0,
  });
  const waiting = search.trim() !== term;
  const rows = useMemo(
    () =>
      waiting
        ? []
        : [
            ...new Map(
              (authors.data?.pages.flatMap((page) => page.items) ?? [])
                .filter(
                  (item) =>
                    item.authorizationStatus === "authorized" &&
                    !item.deletedAt,
                )
                .map((item) => [item.id, item]),
            ).values(),
          ],
    [waiting, authors.data],
  );
  const selected = useQuery<Author | null>({
    queryKey: ["authors", "picker-selected", value],
    enabled: Boolean(value),
    initialData: () => rows.find((item) => item.id === value),
    queryFn: async ({ signal }) => {
      const result = await client.GET("/api/authors/{id}", {
        params: { path: { id: value } },
        signal,
      });
      if (result.response.status === 404) return null;
      return unwrap(result);
    },
    staleTime: 15000,
    refetchInterval: 30000,
  });
  function choose(author: Author) {
    setRevoked(false);
    cache.setQueryData(["authors", "picker-selected", author.id], author);
    onValueChange(author.id);
  }
  useEffect(() => {
    if (
      !autoSelectFirst ||
      autoSelected.current ||
      value ||
      waiting ||
      !rows[0]
    )
      return;
    autoSelected.current = true;
    cache.setQueryData(["authors", "picker-selected", rows[0].id], rows[0]);
    onValueChange(rows[0].id);
  }, [autoSelectFirst, cache, onValueChange, rows, value, waiting]);
  useEffect(() => {
    if (
      value &&
      selected.isSuccess &&
      (!selected.data ||
        selected.data.authorizationStatus !== "authorized" ||
        selected.data.deletedAt)
    ) {
      autoSelected.current = true;
      setRevoked(true);
      onValueChange("");
    }
  }, [value, selected.data, selected.isSuccess, onValueChange]);
  return (
    <fieldset className="author-picker" disabled={disabled}>
      <legend>{label}</legend>
      {value && selected.data && (
        <div className="author-picker__selected">
          已选：{selected.data.displayName}
        </div>
      )}
      <SearchField
        aria-label={`搜索${label}`}
        placeholder="搜索姓名、账号或 Pixiv ID"
        type="search"
        maxLength={100}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div
        className="author-picker__results"
        role="listbox"
        aria-label={`${label}搜索结果`}
        aria-busy={waiting || authors.isFetching}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
            return;
          const options = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="option"]',
            ),
          );
          if (!options.length) return;
          event.preventDefault();
          const current = options.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const index =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? options.length - 1
                : (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    options.length) %
                  options.length;
          options[index].focus();
        }}
      >
        {rows.map((author) => (
          <button
            type="button"
            className="author-picker__option"
            role="option"
            aria-selected={value === author.id}
            key={author.id}
            onClick={() => choose(author)}
          >
            <span>{author.displayName}</span>
            {author.externalAccounts[0] && (
              <small>
                {author.externalAccounts[0].platform === "x"
                  ? `@${author.externalAccounts[0].handle ?? author.externalAccounts[0].externalUserId}`
                  : `${author.externalAccounts[0].platform} ${author.externalAccounts[0].externalUserId}`}
              </small>
            )}
          </button>
        ))}
      </div>
      {revoked ? (
        <p role="status">所选作者已不再可用于上传，请重新选择</p>
      ) : waiting || authors.isPending ? (
        <p role="status">正在搜索…</p>
      ) : !rows.length && !authors.isError ? (
        <p role="status">没有匹配的授权作者</p>
      ) : null}
      {(authors.isError || selected.isError) && (
        <p className="account-error" role="alert">
          {(authors.error ?? selected.error)?.message}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              void authors.refetch();
              if (value) void selected.refetch();
            }}
          >
            重试
          </Button>
        </p>
      )}
      {!waiting && authors.hasNextPage && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          loading={authors.isFetchingNextPage}
          onClick={() => void authors.fetchNextPage()}
        >
          继续加载作者
        </Button>
      )}
    </fieldset>
  );
}
