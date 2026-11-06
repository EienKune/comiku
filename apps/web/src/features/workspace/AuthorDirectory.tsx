import { useEffect, useState, type ComponentProps } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { Grid2X2, List, Plus, UserRound } from "lucide-react";
import { Link } from "react-router";
import { AuthorAvatar } from "./AuthorAvatar";
import { PlatformLinks } from "../../components/PlatformLinks";
import {
  Badge,
  Button,
  EmptyState,
  SearchField,
  SelectControl,
  Surface,
} from "../../components/ui";
import { client, unwrap } from "../account/api";
import { sourceLanguageLabels, authorizationLabels } from "./author-labels";
import "./author-directory.css";

type Author = components["schemas"]["AuthorDto"];
type AccountFilter = components["schemas"]["AuthorAccountFilter"];
type Authorization = Author["authorizationStatus"];
type Tone = NonNullable<ComponentProps<typeof Badge>["tone"]>;
const collectionLabels: Record<AccountFilter, string> = {
  linked: "已关联",
  enabled: "已开启",
  disabled: "已关闭",
  unlinked: "未关联",
};
const tagTones: Tone[] = ["violet", "translation", "info", "warning"];
function AuthorIdentity({ author }: { author: Author }) {
  return (
    <div className="author-directory-identity">
      <AuthorAvatar author={author} />
      <Link
        className="author-directory-name"
        title={author.displayName}
        to={"/authors/" + author.id}
      >
        {author.displayName}
      </Link>
      <Badge
        tone={
          author.authorizationStatus === "authorized"
            ? "success"
            : author.authorizationStatus === "revoked"
              ? "danger"
              : "warning"
        }
      >
        {authorizationLabels[author.authorizationStatus]}
      </Badge>
    </div>
  );
}
function AuthorTags({ author }: { author: Author }) {
  return (
    <span className="author-directory-tags">
      <Badge tone="info" className="author-directory-language">
        {sourceLanguageLabels[author.sourceLanguage]}
      </Badge>
      {author.tags.map((tag) => {
        const hash = Array.from(tag.name.normalize("NFKC")).reduce(
          (n, c) => (n * 31 + c.codePointAt(0)!) >>> 0,
          0,
        );
        return (
          <Badge key={tag.id} tone={tagTones[hash % tagTones.length]}>
            {tag.name}
          </Badge>
        );
      })}
    </span>
  );
}
function AuthorPlatforms({ author }: { author: Author }) {
  const warning =
    author.authorizationStatus !== "authorized"
      ? "作者授权" +
        authorizationLabels[author.authorizationStatus].replace(/^已/, "") +
        "，当前不会采集"
      : undefined;
  return (
    <PlatformLinks
      accounts={author.externalAccounts}
      variant="accounts"
      collectionBlockedReason={warning}
    />
  );
}
export function AuthorDirectory({ onCreate }: { onCreate?: () => void }) {
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [authorization, setAuthorization] = useState<Authorization | "">("");
  const [xState, setXState] = useState<AccountFilter | "">("");
  const [pixivState, setPixivState] = useState<AccountFilter | "">("");
  const [view, setView] = useState<"cards" | "rows">("cards");
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const waiting = search.trim() !== term;
  const query = useInfiniteQuery({
    queryKey: ["authors", "directory", term, authorization, xState, pixivState],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await client.GET("/api/authors", {
          params: {
            query: {
              limit: 50,
              search: term || undefined,
              authorizationStatus: authorization || undefined,
              xState: xState || undefined,
              pixivState: pixivState || undefined,
              cursor: pageParam,
            },
          },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = [
    ...new Map(
      (query.data?.pages.flatMap((p) => p.items) ?? []).map((a) => [a.id, a]),
    ).values(),
  ];
  const total = query.data?.pages[0]?.total ?? 0;
  const active = Boolean(search || authorization || xState || pixivState);
  function reset() {
    setSearch("");
    setTerm("");
    setAuthorization("");
    setXState("");
    setPixivState("");
  }
  return (
    <div className="author-directory">
      <div className="author-directory-toolbar">
        <SearchField
          aria-label="搜索作者"
          placeholder="搜索作者昵称或平台账号"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div
          className="workspace-view-toggle"
          role="group"
          aria-label="作者展示方式"
        >
          <Button
            size="sm"
            variant={view === "cards" ? "primary" : "ghost"}
            aria-pressed={view === "cards"}
            leadingIcon={<Grid2X2 size={15} />}
            onClick={() => setView("cards")}
          >
            卡片
          </Button>
          <Button
            size="sm"
            variant={view === "rows" ? "primary" : "ghost"}
            aria-pressed={view === "rows"}
            leadingIcon={<List size={15} />}
            onClick={() => setView("rows")}
          >
            列表
          </Button>
        </div>
        {onCreate && (
          <Button leadingIcon={<Plus size={16} />} onClick={onCreate}>
            新增作者
          </Button>
        )}
      </div>
      <div
        className="author-directory-filters"
        role="group"
        aria-label="作者筛选"
      >
        <div
          className="author-directory-filter"
          data-active={Boolean(authorization)}
        >
          <span>授权</span>
          <SelectControl
            aria-label="授权状态"
            value={authorization}
            onValueChange={(v) => setAuthorization(v as Authorization | "")}
          >
            <option value="">全部</option>
            {Object.entries(authorizationLabels).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </SelectControl>
        </div>
        {(
          [
            ["X", xState, setXState],
            ["Pixiv", pixivState, setPixivState],
          ] as const
        ).map(([platform, value, setValue]) => (
          <div
            key={platform}
            className="author-directory-filter"
            data-active={Boolean(value)}
          >
            <span>{platform} 采集</span>
            <SelectControl
              aria-label={platform + " 采集状态"}
              value={value}
              onValueChange={(v) => setValue(v as AccountFilter | "")}
            >
              <option value="">全部</option>
              {Object.entries(collectionLabels).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </SelectControl>
          </div>
        ))}
        {active && (
          <Button size="sm" variant="ghost" onClick={reset}>
            清除筛选
          </Button>
        )}
        <span className="author-directory-count" aria-live="polite">
          {waiting ? "正在筛选…" : "共 " + total + " 位作者"}
        </span>
      </div>
      {query.isPending || waiting ? (
        <Surface className="workspace-state">正在加载作者目录…</Surface>
      ) : query.isError ? (
        <Surface className="workspace-state">
          <p>{query.error.message}</p>
          <Button variant="secondary" onClick={() => void query.refetch()}>
            重试
          </Button>
        </Surface>
      ) : !items.length ? (
        <EmptyState
          icon={<UserRound size={24} />}
          title={active ? "没有符合条件的作者" : "暂无作者"}
          description={
            active
              ? "试试其他昵称、账号，或减少筛选条件。"
              : "可以使用新增作者或 CSV 批量导入。"
          }
          action={
            active ? (
              <Button variant="secondary" onClick={reset}>
                清除筛选
              </Button>
            ) : undefined
          }
        />
      ) : view === "cards" ? (
        <div className="author-directory-grid">
          {items.map((author) => (
            <Surface
              as="article"
              className="author-directory-card"
              key={author.id}
            >
              <AuthorIdentity author={author} />
              <AuthorPlatforms author={author} />
              <AuthorTags author={author} />
            </Surface>
          ))}
        </div>
      ) : (
        <Surface className="author-directory-table-wrap">
          <table className="author-directory-table">
            <caption className="visually-hidden">
              作者列表，平台图标表示采集开关设置
            </caption>
            <thead>
              <tr>
                <th scope="col">作者</th>
                <th scope="col">平台账号 / 采集</th>
                <th scope="col">母语</th>
                <th scope="col">标签</th>
              </tr>
            </thead>
            <tbody>
              {items.map((author) => (
                <tr key={author.id}>
                  <td>
                    <AuthorIdentity author={author} />
                  </td>
                  <td>
                    <AuthorPlatforms author={author} />
                  </td>
                  <td className="author-directory-language-cell">
                    <Badge tone="info">
                      {sourceLanguageLabels[author.sourceLanguage]}
                    </Badge>
                  </td>
                  <td>
                    <AuthorTags author={author} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Surface>
      )}
      {!waiting && !query.isError && items.length > 0 && (
        <div className="workspace-pagination">
          <span>
            已显示 {items.length} / {total} 位作者
          </span>
          {query.hasNextPage && (
            <Button
              variant="secondary"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              加载更多
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
