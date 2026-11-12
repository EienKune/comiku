import { workflowLabels, reviewLabels } from "./work-status";
import { useDeferredValue, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { WorkViewNavigation, type WorkPerspective } from "./WorkViewNavigation";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  GripVertical,
  Plus,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  SearchField,
  Surface,
  TextField,
} from "../../components/ui";
import { Feedback, SectionHeading } from "../account/forms";
import { useAccount } from "../account/account-context";
import { useAction } from "../account/use-action";
import {
  CandidateAuthorFilter,
  type CandidateAuthorChoice,
} from "./CandidateAuthorFilter";
import { SeriesImage } from "./SeriesImage";
import {
  seriesApi,
  type SeriesEntry,
  type SeriesSummary,
} from "./work-series-api";
import { client, unwrap } from "../account/api";
import { useCandidateDialog } from "./use-candidate-dialog";
import "./work-series.css";

export function WorkSeriesDirectoryPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAccount(),
    [search, setSearch] = useState(""),
    [author, setAuthor] = useState<CandidateAuthorChoice | null>(null),
    [create, setCreate] = useState(false);
  const term = useDeferredValue(search.trim());
  const query = useInfiniteQuery({
    queryKey: ["work-series", "directory", term, author?.id],
    enabled: user.permissions.includes("works:read"),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      seriesApi.list(
        {
          search: term || undefined,
          authorId: author?.id,
          cursor: pageParam,
          limit: 20,
        },
        signal,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  function changePerspective(next: WorkPerspective) {
    if (next === "series") return;
    const saved: unknown = location.state?.worksViewQuery;
    const params = new URLSearchParams(typeof saved === "string" ? saved : "");
    if (params.get("view") !== next) {
      params.delete("tab");
      params.delete("phase");
      params.delete("unassignedStage");
    }
    params.set("view", next);
    navigate(`/works?${params.toString()}`);
  }
  if (!user.permissions.includes("works:read"))
    return <p>没有查看作品的权限。</p>;
  return (
    <div className="account-content-boundary">
      <SectionHeading title="作品">
        查看流程全貌，或按自己的职务和语言能力接取工作。
      </SectionHeading>
      <WorkViewNavigation active="series" onChange={changePerspective} />
      <div className="series-toolbar">
        <SearchField
          aria-label="搜索系列名称"
          placeholder="搜索系列名称"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <CandidateAuthorFilter value={author} onChange={setAuthor} />
        {user.permissions.includes("works:metadata") && (
          <Button
            leadingIcon={<Plus size={16} />}
            onClick={() => setCreate(true)}
          >
            新建系列
          </Button>
        )}
      </div>
      <Feedback error={query.error?.message} />
      {query.isPending && <p role="status">正在读取系列…</p>}
      <p className="workspace-result-count">
        共 {query.data?.pages[0]?.total ?? 0} 个系列
      </p>
      <div className="series-directory">
        {query.data?.pages
          .flatMap((p) => p.items)
          .map((s) => (
            <Surface as="article" className="series-card" key={s.id}>
              <Link
                to={`/works/series/${s.id}`}
                state={location.state}
                className="series-card-cover"
                aria-label={`打开系列 ${s.title}`}
              >
                {s.coverImages.length ? (
                  s.coverImages.map((image, i) => (
                    <span key={i}>
                      <SeriesImage {...image} />
                    </span>
                  ))
                ) : (
                  <BookOpen size={38} />
                )}
              </Link>
              <div className="series-card-body">
                <h2>
                  <Link to={`/works/series/${s.id}`} state={location.state}>
                    {s.title}
                  </Link>
                </h2>
                <span>{s.authorName}</span>
                <div className="series-card-meta">
                  <span>{s.memberCount} 部作品</span>
                  <time>
                    {new Date(s.updatedAt).toLocaleDateString("zh-CN")}
                  </time>
                </div>
              </div>
            </Surface>
          ))}
      </div>
      {query.isSuccess && !query.data.pages[0].items.length && (
        <EmptyState
          icon={<BookOpen />}
          title="没有找到匹配的系列"
          description="调整搜索或作者筛选后再试。"
        />
      )}
      {query.hasNextPage && (
        <Button
          variant="secondary"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          加载更多系列
        </Button>
      )}
      {create && <CreateSeriesDialog onClose={() => setCreate(false)} />}
    </div>
  );
}
function CreateSeriesDialog({ onClose }: { onClose: () => void }) {
  const ref = useCandidateDialog(),
    [title, setTitle] = useState(""),
    [author, setAuthor] = useState<CandidateAuthorChoice | null>(null),
    [requestId, setRequestId] = useState(() => crypto.randomUUID()),
    action = useAction(),
    cache = useQueryClient();
  return (
    <dialog
      ref={ref}
      className="series-dialog"
      aria-label="新建系列"
      onCancel={(e) => {
        e.preventDefault();
        if (!action.busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await seriesApi.create({
              title: title.trim(),
              authorId: author!.id,
              requestId,
            });
            await cache.invalidateQueries({ queryKey: ["work-series"] });
            onClose();
          });
        }}
      >
        <div className="series-heading">
          <h2>新建系列</h2>
          <IconButton
            type="button"
            label="关闭新建系列"
            onClick={onClose}
            disabled={action.busy}
          >
            <X size={20} />
          </IconButton>
        </div>
        <TextField
          label="系列名称"
          required
          maxLength={200}
          value={title}
          disabled={action.busy}
          onChange={(e) => {
            setTitle(e.target.value);
            setRequestId(crypto.randomUUID());
          }}
        />
        <fieldset disabled={action.busy} className="series-author-field">
          <CandidateAuthorFilter
            value={author}
            onChange={(next) => {
              setAuthor(next);
              setRequestId(crypto.randomUUID());
            }}
          />
        </fieldset>
        <Feedback error={action.error} />
        <div className="series-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={action.busy}
          >
            取消
          </Button>
          <Button
            type="submit"
            loading={action.busy}
            disabled={!title.trim() || !author}
          >
            创建系列
          </Button>
        </div>
      </form>
    </dialog>
  );
}
export function WorkSeriesDetailPage() {
  const location = useLocation();
  const { seriesId = "" } = useParams(),
    user = useAccount(),
    cache = useQueryClient(),
    action = useAction(),
    [includeHistory, setIncludeHistory] = useState(false),
    [editing, setEditing] = useState(false),
    [adding, setAdding] = useState(false),
    [title, setTitle] = useState("");
  const query = useInfiniteQuery({
    queryKey: ["work-series", "detail", seriesId, includeHistory],
    enabled: user.permissions.includes("works:read"),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      seriesApi.detail(
        seriesId,
        { cursor: pageParam, limit: 50, includeHistory },
        signal,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const series = query.data?.pages[0],
    entries = query.data?.pages.flatMap((p) => p.entries) ?? [],
    canEdit =
      user.permissions.includes("works:metadata") &&
      (!series?.archived || user.permissions.includes("works:admin"));
  const revision = () => ({
    expectedRevision: series!.revision,
    requestId: crypto.randomUUID(),
  });
  async function write(operation: () => Promise<SeriesSummary>) {
    await operation();
    await cache.invalidateQueries({ queryKey: ["work-series"] });
  }
  function move(entry: SeriesEntry, index: number) {
    if (index < 0 || index >= entries.length) return;
    const rest = entries.filter((e) => e.id !== entry.id),
      after = rest[index - 1]?.id ?? null;
    void action.run(() =>
      write(() =>
        seriesApi.updateEntry(seriesId, entry.id, {
          ...revision(),
          afterEntryId: after,
        }),
      ),
    );
  }
  if (!user.permissions.includes("works:read"))
    return <p>没有查看作品的权限。</p>;
  return (
    <div className="account-content-boundary">
      <Link className="account-link" to="/works/series" state={location.state}>
        <ArrowLeft size={16} />
        返回系列
      </Link>
      <Feedback error={query.error?.message || action.error} />
      {!series ? (
        query.isPending && <p role="status">正在读取系列…</p>
      ) : (
        <>
          <div className="series-heading">
            <div>
              <h1>{series.title}</h1>
              <p>
                {series.authorName} · {series.memberCount} 部作品
              </p>
            </div>
            {canEdit && (
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(!editing);
                  setTitle(series.title);
                }}
              >
                {editing ? "完成管理" : "管理目录"}
              </Button>
            )}
          </div>
          {editing && (
            <form
              className="series-toolbar"
              onSubmit={(e) => {
                e.preventDefault();
                void action.run(() =>
                  write(() =>
                    seriesApi.update(seriesId, {
                      ...revision(),
                      title: title.trim(),
                    }),
                  ),
                );
              }}
            >
              <TextField
                label="系列名称"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={200}
              />
              <Button
                type="submit"
                loading={action.busy}
                disabled={!title.trim()}
              >
                保存名称
              </Button>
              <Button
                type="button"
                variant="secondary"
                leadingIcon={<Plus size={16} />}
                onClick={() => {
                  action.clearError();
                  setAdding(true);
                }}
              >
                添加已有作品
              </Button>
            </form>
          )}
          <label className="account-checkbox series-history-toggle">
            <input
              type="checkbox"
              checked={includeHistory}
              onChange={(event) => setIncludeHistory(event.target.checked)}
            />
            显示已归档或舍弃的作品
          </label>
          <Surface className="series-entry-list">
            {entries.map((entry, i) => (
              <div
                className="series-entry"
                data-series-entry={entry.id}
                key={entry.id}
              >
                {editing && (
                  <IconButton
                    label={`拖动 ${entry.title ?? entry.workNumber}`}
                    disabled={action.busy}
                    className="series-drag"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerUp={(e) => {
                      if (!e.currentTarget.hasPointerCapture(e.pointerId))
                        return;
                      e.currentTarget.releasePointerCapture(e.pointerId);
                      const target = document
                        .elementFromPoint(e.clientX, e.clientY)
                        ?.closest<HTMLElement>("[data-series-entry]");
                      const index = entries.findIndex(
                        (item) => item.id === target?.dataset.seriesEntry,
                      );
                      if (index >= 0 && index !== i) move(entry, index);
                    }}
                  >
                    <GripVertical size={18} />
                  </IconButton>
                )}
                <Link
                  to={`/works/${entry.workId}`}
                  className="series-entry-cover"
                >
                  <SeriesImage
                    workId={entry.workId}
                    imageId={entry.coverImageId}
                  />
                </Link>
                <div className="series-entry-info">
                  <Link to={`/works/${entry.workId}`}>
                    {entry.title || `作品 #${entry.workNumber}`}
                  </Link>
                  <span>
                    #{entry.workNumber} · {entry.imageCount} 页
                    {entry.archived ? " · 已归档" : ""}
                  </span>
                  <div className="series-entry-status">
                    <Badge>{workflowLabels[entry.workflowStatus]}</Badge>
                    {entry.reviewStatus !== "normal" && (
                      <Badge tone="warning">
                        {reviewLabels[entry.reviewStatus]}
                      </Badge>
                    )}
                  </div>
                  {editing ? (
                    <TextField
                      key={`${entry.id}-${series.revision}`}
                      aria-label={`作品 #${entry.workNumber} 的章节标签`}
                      defaultValue={entry.label ?? ""}
                      placeholder="章节标签"
                      maxLength={100}
                      disabled={action.busy}
                      onBlur={(e) => {
                        const label = e.target.value.trim();
                        if (label !== (entry.label ?? ""))
                          void action.run(() =>
                            write(() =>
                              seriesApi.updateEntry(seriesId, entry.id, {
                                ...revision(),
                                label: label || null,
                              }),
                            ),
                          );
                      }}
                    />
                  ) : (
                    entry.label && <strong>{entry.label}</strong>
                  )}
                </div>
                {editing && (
                  <div className="series-entry-controls">
                    <IconButton
                      label={`上移作品 #${entry.workNumber}`}
                      disabled={!i || action.busy}
                      onClick={() => move(entry, i - 1)}
                    >
                      <ArrowUp size={16} />
                    </IconButton>
                    <IconButton
                      label={`下移作品 #${entry.workNumber}`}
                      disabled={i === entries.length - 1 || action.busy}
                      onClick={() => move(entry, i + 1)}
                    >
                      <ArrowDown size={16} />
                    </IconButton>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(() =>
                          write(() =>
                            seriesApi.remove(seriesId, entry.id, revision()),
                          ),
                        )
                      }
                    >
                      移出
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {!entries.length && (
              <EmptyState
                icon={<BookOpen />}
                title="系列中还没有作品"
                description="可以从同作者的已有作品中添加。"
              />
            )}
          </Surface>
          {query.hasNextPage && (
            <Button
              variant="secondary"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              加载更多作品
            </Button>
          )}
          {adding && (
            <AddSeriesWorks
              series={series}
              entries={entries}
              error={action.error}
              onClose={() => setAdding(false)}
              onAdd={(ids) =>
                action.run(async () => {
                  await write(() =>
                    seriesApi.add(seriesId, { ...revision(), workIds: ids }),
                  );
                  setAdding(false);
                })
              }
            />
          )}
        </>
      )}
    </div>
  );
}
function AddSeriesWorks({
  series,
  entries,
  error,
  onClose,
  onAdd,
}: {
  series: SeriesSummary;
  entries: readonly SeriesEntry[];
  error: string;
  onClose: () => void;
  onAdd: (ids: string[]) => Promise<void>;
}) {
  const ref = useCandidateDialog(),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState(false),
    term = useDeferredValue(search.trim());
  const query = useInfiniteQuery({
    queryKey: ["series-available-works", series.authorId, term],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await client.GET("/api/works", {
          params: {
            query: {
              authorId: series.authorId,
              search: term || undefined,
              cursor: pageParam,
              limit: 24,
            },
          },
          signal,
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  return (
    <dialog
      ref={ref}
      className="series-dialog"
      aria-label="添加已有作品"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="series-heading">
        <h2>添加已有作品</h2>
        <IconButton label="关闭添加作品" onClick={onClose} disabled={busy}>
          <X size={20} />
        </IconButton>
      </div>
      <SearchField
        aria-label="搜索同作者作品"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="series-add-list">
        {query.data?.pages
          .flatMap((p) => p.items)
          .filter((w) => !entries.some((entry) => entry.workId === w.id))
          .map((w) => (
            <label key={w.id} className="account-checkbox">
              <input
                type="checkbox"
                checked={selected.has(w.id)}
                disabled={busy || (!selected.has(w.id) && selected.size >= 100)}
                onChange={(e) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (e.target.checked) next.add(w.id);
                    else next.delete(w.id);
                    return next;
                  })
                }
              />
              <span>
                {w.title || `作品 #${w.workNumber}`} · #{w.workNumber}
              </span>
            </label>
          ))}
      </div>
      {query.hasNextPage && (
        <Button variant="ghost" onClick={() => void query.fetchNextPage()}>
          加载更多
        </Button>
      )}
      <Feedback error={error || query.error?.message} />
      <div className="series-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          loading={busy}
          disabled={!selected.size}
          onClick={() => {
            setBusy(true);
            void onAdd([...selected]).finally(() => setBusy(false));
          }}
        >
          添加 {selected.size || ""} 部作品
        </Button>
      </div>
    </dialog>
  );
}
