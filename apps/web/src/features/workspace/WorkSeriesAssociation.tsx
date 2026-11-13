import { useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "react-router";
import { ArrowLeft, ArrowRight, BookOpen } from "lucide-react";
import { Button, SelectField, TextField } from "../../components/ui";
import { Feedback } from "../account/forms";
import { useAction } from "../account/use-action";
import { seriesApi, type SeriesImportIntent } from "./work-series-api";
import "./work-series.css";
export function SeriesImportSelector({
  authorId,
  value,
  onChange,
  disabled = false,
  allowCreate = true,
  showLabel = true,
}: {
  authorId: string;
  value: SeriesImportIntent | null;
  onChange: (intent: SeriesImportIntent | null) => void;
  disabled?: boolean;
  allowCreate?: boolean;
  showLabel?: boolean;
}) {
  const query = useInfiniteQuery({
    queryKey: ["work-series", "author", authorId],
    enabled: !disabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      seriesApi.list({ authorId, cursor: pageParam, limit: 50 }, signal),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const selected = value ? ("seriesId" in value ? value.seriesId : "new") : "";
  return (
    <div className="series-import-selector">
      <SelectField
        label="关联系列（可选）"
        value={selected}
        disabled={disabled || query.isPending}
        onValueChange={(id) => {
          if (!id) onChange(null);
          else if (id === "new")
            onChange({ createTitle: "", requestId: crypto.randomUUID() });
          else {
            const series = query.data?.pages
              .flatMap((p) => p.items)
              .find((s) => s.id === id);
            if (series)
              onChange({
                seriesId: series.id,
                expectedRevision: series.revision,
              });
          }
        }}
      >
        <option value="">不关联系列</option>
        {query.data?.pages
          .flatMap((p) => p.items)
          .map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        {allowCreate && <option value="new">新建系列…</option>}
      </SelectField>
      {value && "createTitle" in value && (
        <TextField
          label="新系列名称"
          required
          maxLength={200}
          value={value.createTitle}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, createTitle: e.target.value })}
        />
      )}
      {value && showLabel && (
        <TextField
          label="章节标签"
          value={value.label ?? ""}
          disabled={disabled}
          maxLength={100}
          onChange={(e) => onChange({ ...value, label: e.target.value })}
        />
      )}
      {query.hasNextPage && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          加载更多系列
        </Button>
      )}
      <Feedback error={query.error?.message} />
    </div>
  );
}
export function WorkSeriesAssociation({
  workId,
  authorId,
  canManage,
}: {
  workId: string;
  authorId: string;
  canManage: boolean;
}) {
  const query = useQuery({
      queryKey: ["work-series", "context", workId],
      queryFn: ({ signal }) => seriesApi.context(workId, signal),
    }),
    [editing, setEditing] = useState(false),
    [intent, setIntent] = useState<SeriesImportIntent | null>(null),
    action = useAction(),
    cache = useQueryClient();
  const context = query.data;
  return (
    <section className="work-series-association">
      <div className="series-heading">
        <div>
          {context?.series ? (
            <Link
              className="account-link"
              to={`/works/series/${context.series.id}`}
            >
              <BookOpen size={16} />
              {context.series.title}
              {context.currentEntry?.label
                ? ` · ${context.currentEntry.label}`
                : ""}
            </Link>
          ) : (
            <span>尚未关联系列</span>
          )}
        </div>
        {canManage && (
          <Button
            size="sm"
            variant="ghost"
            disabled={query.isPending}
            onClick={() => setEditing(!editing)}
          >
            {editing ? "取消" : "关联系列"}
          </Button>
        )}
      </div>
      <Feedback error={query.error?.message || action.error} />
      {editing && (
        <div className="series-associate-form">
          {context?.series ? (
            <>
              <TextField
                label="章节标签"
                key={context.currentEntry?.id}
                defaultValue={context.currentEntry?.label ?? ""}
                onBlur={(e) => {
                  const label = e.target.value.trim();
                  if (label === (context.currentEntry?.label ?? "")) return;
                  void action.run(async () => {
                    await seriesApi.updateEntry(
                      context.series!.id,
                      context.currentEntry!.id,
                      {
                        label: label || null,
                        expectedRevision: context.series!.revision,
                        requestId: crypto.randomUUID(),
                      },
                    );
                    await cache.invalidateQueries({
                      queryKey: ["work-series"],
                    });
                  });
                }}
              />
              <Button
                variant="ghost"
                loading={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await seriesApi.remove(
                      context.series!.id,
                      context.currentEntry!.id,
                      {
                        expectedRevision: context.series!.revision,
                        requestId: crypto.randomUUID(),
                      },
                    );
                    await cache.invalidateQueries({
                      queryKey: ["work-series"],
                    });
                    setEditing(false);
                  })
                }
              >
                移出当前系列
              </Button>
            </>
          ) : (
            <>
              <SeriesImportSelector
                authorId={authorId}
                value={intent}
                onChange={setIntent}
                showLabel={false}
                disabled={action.busy}
              />
              <Button
                disabled={
                  !intent ||
                  ("createTitle" in intent && !intent.createTitle.trim())
                }
                loading={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    if (!intent) return;
                    if ("createTitle" in intent)
                      await seriesApi.create({
                        authorId,
                        title: intent.createTitle.trim(),
                        workIds: [workId],
                        requestId: intent.requestId,
                      });
                    else
                      await seriesApi.add(intent.seriesId, {
                        workIds: [workId],
                        expectedRevision: intent.expectedRevision,
                        requestId: crypto.randomUUID(),
                      });
                    await cache.invalidateQueries({
                      queryKey: ["work-series"],
                    });
                    setEditing(false);
                    setIntent(null);
                  })
                }
              >
                保存关联
              </Button>
            </>
          )}
        </div>
      )}
      {context?.series && (
        <nav className="series-work-navigation" aria-label="系列作品导航">
          {context.previous ? (
            <Link to={`/works/${context.previous.workId}`}>
              <ArrowLeft size={16} />
              <span>
                上一部 ·{" "}
                {context.previous.label ||
                  context.previous.title ||
                  `#${context.previous.workNumber}`}
              </span>
            </Link>
          ) : (
            <span />
          )}
          {context.next && (
            <Link to={`/works/${context.next.workId}`}>
              <span>
                下一部 ·{" "}
                {context.next.label ||
                  context.next.title ||
                  `#${context.next.workNumber}`}
              </span>
              <ArrowRight size={16} />
            </Link>
          )}
        </nav>
      )}
    </section>
  );
}
