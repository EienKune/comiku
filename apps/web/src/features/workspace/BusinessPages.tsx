import { downloadPrepared, uploadDirect, pollTransfer } from "./transfers-api";
import { useImageUrl } from "../../components/use-image-url";
import { refreshReviewViews } from "./review-cache";
import { useCandidateAnalysisRefresh } from "./use-candidate-analysis-refresh";
import { MemberAvatar } from "../account/MemberAvatar";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Download,
  ExternalLink,
  FileCheck2,
  FileText,
  ImageIcon,
  Images,
  Inbox,
  Grid2X2,
  List,
  Plus,
  RefreshCw,
  ScanText,
  Search,
  Upload,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { SkipProofreadingButton } from "./SkipProofreadingButton";
import {
  Badge,
  Button,
  EmptyState,
  SearchField,
  SelectField,
  Surface,
  TextField,
} from "../../components/ui";
import { isDisplayableImageUrl } from "../../components/media-url";
import { ImageLightbox } from "../../components/ImageLightbox";
import { OptionalSection } from "../../components/OptionalSection";
import { PlatformLinks } from "../../components/PlatformLinks";
import { useAccount } from "../account/account-context";
import { useTopbarActions } from "../account/topbar-actions";
import {
  authenticatedFetch,
  client,
  queryClient,
  unwrap,
} from "../account/api";
import { Feedback, SectionHeading } from "../account/forms";
import { useAction } from "../account/use-action";
import { deleteTranslationDraft } from "../editor/draft-storage";
import { TypesetBatchTools } from "./TypesetBatchTools";
import { ReviewRequestActions } from "./ReviewRequestActions";
import { AuthorAccountsPanel } from "./AuthorAccountsPanel";
import { sourceAdapterLabels } from "./source-labels";
import {
  canHandleStage,
  workingTabs,
  workViewState,
  type ClaimStage,
  type WorkTab,
} from "./work-views";
import { useSettingsNavigation } from "../account/settings-routing";

type Author = components["schemas"]["AuthorDto"];
type AuthorImportPreview = components["schemas"]["AuthorImportPreviewDto"];
type ResolvedXProfile = components["schemas"]["ResolvedXProfileDto"];
type Candidate = components["schemas"]["CandidateDto"];
type CandidateTagGroup = components["schemas"]["CandidateTagGroupDto"];
type CandidateUploadSession =
  components["schemas"]["CandidateUploadSessionDto"];
type CandidateUploadContentType =
  components["schemas"]["CandidateUploadFileDto"]["contentType"];
type Work = components["schemas"]["WorkDto"];
type WorkDetail = components["schemas"]["WorkDetailDto"];
type Review = components["schemas"]["ReviewCaseDto"];
type WorkflowStatus = components["schemas"]["WorkflowStatus"];
type ReviewStatus = components["schemas"]["ReviewStatus"];
type WorkStage = components["schemas"]["WorkStage"];
type SourceLanguage = components["schemas"]["SourceLanguage"];
type TypesetVersion = components["schemas"]["TypesetVersionDto"];
type TypesetVersionList = components["schemas"]["TypesetVersionListDto"];
type PublishingView = components["schemas"]["PublishingViewDto"];
type WorkEventAction = components["schemas"]["WorkEventAction"];
type WorkPhase = components["schemas"]["WorkPhase"];

function workDisplayTitle(work: Pick<Work, "workNumber" | "title">) {
  return work.title?.trim() || `#${work.workNumber} · 待定标题`;
}

const sourceLanguageLabels: Record<SourceLanguage, string> = {
  ja: "日语",
  ko: "韩语",
  en: "英语",
};

const workflowLabels: Record<WorkflowStatus, string> = {
  pending_translate: "待翻译",
  translating: "翻译中",
  pending_proofread: "待校对",
  proofreading: "校对中",
  pending_typeset: "待嵌字",
  typesetting: "嵌字中",
  pending_publish: "待发布",
  published: "已发布",
  archived: "已归档",
};
const reviewLabels: Record<ReviewStatus, string> = {
  normal: "正常",
  needs_review: "待审核",
  blocked: "阻塞",
};
const reviewResolutionLabels: Record<
  components["schemas"]["ReviewResolution"],
  string
> = {
  continue_production: "继续制作",
  discard: "舍弃作品",
  restore_production: "恢复制作",
  approve_revision: "历史：批准内容修订",
  withdrawn: "已撤销审核请求",
  resume: "恢复原阶段（历史）",
  revise: "指定阶段返工",
  keep_pending: "继续等待",
  block: "标记阻塞",
};
const eventLabels: Record<string, string> = {
  imported: "导入作品",
  metadata_updated: "更新信息",
  collaboration_mode_updated: "更新协作模式",
  stage_joined: "加入阶段",
  stage_assigned: "指派负责人",
  stage_credit_updated: "更新作品临时署名",
  stage_assignment_updated: "更新页码分工",
  stage_contribution_completed: "完成本人分工",
  stage_left: "取消参与",
  stage_submitted: "提交阶段",
  translation_revision_submitted: "提交译文修订",
  translation_imported: "导入 LabelPlus",
  typeset_handoff_started: "开始嵌字交接",
  typeset_version_uploaded: "上传成图版本",
  typeset_version_selected: "切换当前成图",
  typeset_version_deleted: "删除成图版本",
  typeset_version_restored: "恢复成图版本",
  publish_confirmed: "确认发布",
  review_opened: "发起内容审核",
  review_withdrawn: "撤销审核请求",
  review_resumed: "恢复流程",
  review_revised: "退回修改",
  review_kept_pending: "继续等待",
  review_blocked: "标记阻塞（历史）",
  review_revision_joined: "本人加入内容修订",
  review_revision_left: "退出本轮修订",
  review_revision_pages_updated: "更新修订分工",
  review_revision_contribution_completed: "确认修订分工完成",
  review_revision_completed: "无变化结束修订",
  typeset_version_reviewed: "成图适配新文本复核",
  archived: "归档作品",
  restored: "恢复作品",
};
const authorizationLabels: Record<string, string> = {
  pending: "待确认",
  authorized: "已授权",
  expired: "已过期",
  revoked: "已撤销",
};
const candidateLabels: Record<string, string> = {
  pending: "待处理",
  imported: "已入库",
  discarded: "已忽略",
};
const candidateTagGroupLabels: Record<
  components["schemas"]["CandidateTagGroupKind"],
  string
> = {
  valid: "有效作品标签",
  gray: "灰名单",
  blocked: "排除标签",
};
const stageLabels: Record<WorkStage, string> = {
  translate: "翻译",
  proofread: "校对",
  typeset: "嵌字",
  publish: "发布",
};

const coordinationStages = [
  "translate",
  "proofread",
  "typeset",
] as const satisfies readonly WorkStage[];
type CoordinatedStage = (typeof coordinationStages)[number];
function dateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
function useApiQuery<T>(
  key: readonly unknown[],
  load: () => Promise<T>,
  enabled = true,
) {
  return useQuery({
    queryKey: key,
    queryFn: load,
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
  });
}
async function invalidateWorkViews(workId?: string) {
  const invalidations = [
    queryClient.invalidateQueries({ queryKey: ["works"] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard-works"] }),
  ];
  if (workId) {
    invalidations.push(
      queryClient.invalidateQueries({ queryKey: ["work", workId] }),
    );
  }
  await Promise.all(invalidations);
}
function PageState<T>({
  query,
  children,
  empty,
  emptyContent,
}: {
  query: {
    isPending: boolean;
    isError: boolean;
    error: Error | null;
    data?: T;
    refetch: () => unknown;
  };
  children: (data: T) => ReactNode;
  empty?: (data: T) => boolean;
  emptyContent?: ReactNode;
}) {
  if (query.isPending)
    return (
      <Surface className="workspace-state" aria-busy="true">
        正在加载…
      </Surface>
    );
  if (query.isError || !query.data)
    return (
      <Surface className="workspace-state">
        <p role="alert">{query.error?.message ?? "暂时无法读取数据"}</p>
        <Button variant="secondary" onClick={() => void query.refetch()}>
          重新加载
        </Button>
      </Surface>
    );
  if (empty?.(query.data))
    return (
      emptyContent ?? (
        <EmptyState
          icon={<Inbox />}
          title="这里暂时没有内容"
          description="数据创建或流转到这里后会自动显示。"
        />
      )
    );
  return children(query.data);
}
function PermissionGate({
  permission,
  children,
}: {
  permission: string;
  children: ReactNode;
}) {
  const user = useAccount();
  return user.permissions.includes(permission) ? (
    children
  ) : (
    <Navigate to="/" replace />
  );
}
function WorkflowBadge({ value }: { value: WorkflowStatus }) {
  const tone = value.includes("translate")
    ? "translation"
    : value.includes("proofread")
      ? "warning"
      : value.includes("typeset")
        ? "violet"
        : value === "published"
          ? "success"
          : "neutral";
  return (
    <Badge tone={tone} dot>
      {workflowLabels[value]}
    </Badge>
  );
}
function ReviewBadge({ value }: { value: ReviewStatus }) {
  const tone =
    value === "normal" ? "success" : value === "blocked" ? "danger" : "warning";
  return (
    <Badge tone={tone} dot>
      {reviewLabels[value]}
    </Badge>
  );
}
function TranslationAttentionBadge({ work }: { work: Work }) {
  return work.translationAttentionStage &&
    work.translationAttentionVersionNumber ? (
    <Badge tone="warning" dot>
      {stageLabels[work.translationAttentionStage]}需关注 · 版本
      {work.translationAttentionVersionNumber}
    </Badge>
  ) : null;
}
function Toolbar({ children }: { children: ReactNode }) {
  return (
    <Surface className="workspace-toolbar" variant="soft">
      {children}
    </Surface>
  );
}

export function DashboardPage() {
  const user = useAccount();
  const query = useApiQuery(
    ["dashboard"],
    async () => unwrap(await client.GET("/api/dashboard/summary")),
    user.permissions.includes("dashboard:read"),
  );
  return (
    <PermissionGate permission="dashboard:read">
      <div className="dashboard-heading">
        <SectionHeading title={`你好，${user.displayName}`}>
          从当前待办开始，共同完成每一页。
        </SectionHeading>
      </div>
      <PageState query={query}>
        {(data) => (
          <>
            <div className="workspace-stats">
              <Surface>
                <span>全部作品</span>
                <strong>{data.totalWorks}</strong>
                <small>当前可见作品</small>
              </Surface>
              <Surface>
                <span>我的参与</span>
                <strong>{data.myParticipatingWorks}</strong>
                <small>按作品去重</small>
              </Surface>
              <Surface>
                <span>
                  {data.pendingCandidates !== null ? "待处理候选" : "待翻译"}
                </span>
                <strong>
                  {data.pendingCandidates ??
                    (data.workflowCounts.find(
                      (item) => item.status === "pending_translate",
                    )?.count ||
                      0)}
                </strong>
                <small>
                  {data.pendingCandidates !== null
                    ? "等待筛选入库"
                    : "等待加入翻译"}
                </small>
              </Surface>
              <Surface>
                <span>审核异常</span>
                <strong>
                  {data.reviewCounts
                    .filter((item) => item.status !== "normal")
                    .reduce((sum, item) => sum + item.count, 0)}
                </strong>
                <small>待审核与阻塞</small>
              </Surface>
            </div>
            {user.permissions.includes("works:read") && (
              <>
                <TypesetBatchTools />
                <PersonalWorkSection view="todo" />
                <PersonalWorkSection view="recommended" />
              </>
            )}
            <Surface className="workspace-activity-panel">
              <div className="workspace-panel-heading">
                <div>
                  <h2>最近活动</h2>
                  <p>显示当前账号有权查看的作品业务事件。</p>
                </div>
                <Link to="/audit">查看全部</Link>
              </div>
              {data.recentActivity.length ? (
                <ol className="workspace-activity-list">
                  {data.recentActivity.map((item) => (
                    <li key={item.id}>
                      <div>
                        <strong>
                          {eventLabels[item.action] ?? item.action}
                        </strong>
                        <Link to={`/works/${item.workId}`}>
                          {item.workTitle}
                        </Link>
                      </div>
                      <span>
                        {item.actorName ?? "系统"} · {dateTime(item.createdAt)}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="workspace-muted">当前范围内还没有业务事件。</p>
              )}
            </Surface>
          </>
        )}
      </PageState>
    </PermissionGate>
  );
}

function PersonalWorkSection({ view }: { view: "todo" | "recommended" }) {
  const user = useAccount();
  // Keep the existing invalidation prefix shared by every workflow mutation.
  const query = useApiQuery(
    ["dashboard-works", user.id, user.revision, view],
    async () =>
      unwrap(
        await client.GET("/api/works", {
          params: { query: { view, limit: 8 } },
        }),
      ),
  );
  const isTodo = view === "todo";
  const hasWorkQualification = coordinationStages.some((stage) =>
    (["ja", "ko", "en"] as const).some((language) =>
      canHandleStage(user, stage, language),
    ),
  );
  const title = isTodo ? "我的待办" : "推荐接取";
  const recommendedTab =
    workingTabs(user).find((tab) =>
      ["translate", "proofread", "typeset"].includes(tab.value),
    )?.value ?? "todo";
  const recommendedLink = `/works?view=work&tab=${recommendedTab}`;
  return (
    <section className="dashboard-works" aria-label={title}>
      <div className="dashboard-works-heading">
        <h2>
          {title} <small>{query.data?.total ?? 0}</small>
        </h2>
        <Link to={isTodo ? "/works?view=work&tab=todo" : recommendedLink}>
          {isTodo ? "查看全部待办" : "查看全部推荐"}
        </Link>
      </div>
      <PageState query={query}>
        {(page) =>
          page.items.length ? (
            <>
              {isTodo ? (
                <div className="workspace-card-grid workspace-work-grid">
                  {page.items.map((work) => (
                    <WorkCard
                      key={work.id}
                      work={work}
                      actions={<PersonalWorkActions work={work} view={view} />}
                    />
                  ))}
                </div>
              ) : (
                [true, false].map((ready) => {
                  const works = page.items.filter(
                    (work) =>
                      work.personalTasks?.some((task) => task.readyToStart) ===
                      ready,
                  );
                  return works.length ? (
                    <div
                      key={String(ready)}
                      className="dashboard-recommendation-group"
                    >
                      <h3>{ready ? "可立即开始" : "提前认领 · 上游未完成"}</h3>
                      <div className="workspace-card-grid workspace-work-grid">
                        {works.map((work) => (
                          <WorkCard
                            key={work.id}
                            work={work}
                            actions={
                              <PersonalWorkActions work={work} view={view} />
                            }
                          />
                        ))}
                      </div>
                    </div>
                  ) : null;
                })
              )}
            </>
          ) : (
            <>
              <EmptyState
                icon={<Inbox />}
                title={
                  hasWorkQualification
                    ? isTodo
                      ? "这里空空如也，去接取新的任务吧"
                      : "暂时没有匹配的可接取任务"
                    : "暂无可处理的翻校嵌任务"
                }
                description={
                  hasWorkQualification
                    ? isTodo
                      ? "提前认领的任务会在上游提交后进入待办。"
                      : "推荐会按你的职务和语言能力更新。"
                    : "图源、运营和审核请使用各自的功能入口。"
                }
              />
              {isTodo && hasWorkQualification && (
                <Link to={recommendedLink}>去接取新任务</Link>
              )}
            </>
          )
        }
      </PageState>
    </section>
  );
}

function PersonalWorkActions({
  work,
  view,
}: {
  work: Work;
  view: "todo" | "recommended";
}) {
  const action = useAction();
  async function claim(stage: CoordinatedStage) {
    await action.run(async () => {
      try {
        await unwrap(
          await client.POST("/api/works/{id}/stages/claim", {
            params: { path: { id: work.id } },
            body: {
              stage,
              expectedRevision: work.revision,
              idempotencyKey: crypto.randomUUID(),
            },
          }),
        );
        action.setSuccess(
          `${stageLabels[stage]}已认领${work.personalTasks?.find((task) => task.stage === stage)?.readyToStart ? "" : "，等待上游完成"}`,
        );
      } finally {
        // Concurrent claims and qualification changes also refresh discovery.
        await invalidateWorkViews(work.id);
      }
    });
  }
  return (
    <div className="workspace-personal-actions">
      {work.personalTasks?.map((task) => (
        <div key={task.stage}>
          {view === "recommended" ? (
            <Button
              size="sm"
              variant="secondary"
              loading={action.busy}
              onClick={() => void claim(task.stage)}
            >
              接取{stageLabels[task.stage]}
              {task.readyToStart ? "" : " · 上游未完成"}
            </Button>
          ) : (
            <Link
              className="ui-button ui-button--secondary ui-button--sm"
              to={
                task.stage === "typeset"
                  ? `/works/${work.id}`
                  : `/works/${work.id}/editor`
              }
            >
              {task.stage === "typeset"
                ? "嵌字交接与成图"
                : `进入${stageLabels[task.stage]}工作区`}
            </Link>
          )}

          {task.contributionCurrent && <small>分工已完成，待阶段提交</small>}
        </div>
      ))}
      <Feedback error={action.error} success={action.success} />
    </div>
  );
}

export function BusinessAuditPage() {
  const user = useAccount();
  const [draftSearch, setDraftSearch] = useState("");
  const [search, setSearch] = useState("");
  const [action, setAction] = useState<WorkEventAction | "all">("all");
  const [days, setDays] = useState<"7" | "30" | "90" | "all">("30");
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const query = useApiQuery(
    ["business-audit", search, action, days, cursor],
    async () =>
      unwrap(
        await client.GET("/api/audit/events", {
          params: {
            query: {
              ...(search ? { search } : {}),
              ...(action === "all" ? {} : { action }),
              ...(days === "all" ? {} : { days: Number(days) as 7 | 30 | 90 }),
              ...(cursor ? { cursor } : {}),
              limit: 30,
            },
          },
        }),
      ),
    user.permissions.includes("works:read"),
  );

  function resetPage() {
    setCursor(null);
    setPrevious([]);
  }

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(draftSearch.trim());
    resetPage();
  }

  return (
    <PermissionGate permission="works:read">
      <SectionHeading title="业务活动记录">
        查询从作品入库到发布确认的不可变事件；账号安全审计仍在账号管理页。
      </SectionHeading>
      <Toolbar>
        <form className="workspace-audit-search" onSubmit={applySearch}>
          <SearchField
            aria-label="搜索业务事件"
            placeholder="搜索作品、作者或操作人"
            value={draftSearch}
            onChange={(event) => setDraftSearch(event.target.value)}
          />
          <Button type="submit" variant="secondary">
            查询
          </Button>
        </form>
        <SelectField
          label="动作"
          value={action}
          onValueChange={(value) => {
            setAction(value as WorkEventAction | "all");
            resetPage();
          }}
        >
          <option value="all">全部动作</option>
          {(Object.entries(eventLabels) as [WorkEventAction, string][]).map(
            ([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ),
          )}
        </SelectField>
        <SelectField
          label="时间范围"
          value={days}
          onValueChange={(value) => {
            setDays(value as typeof days);
            resetPage();
          }}
        >
          <option value="7">最近 7 天</option>
          <option value="30">最近 30 天</option>
          <option value="90">最近 90 天</option>
          <option value="all">全部时间</option>
        </SelectField>
      </Toolbar>
      <PageState query={query}>
        {(page) => (
          <Surface className="workspace-audit-panel">
            <div className="workspace-panel-heading">
              <div>
                <h2>事件列表</h2>
                <p>
                  共 {page.total} 条 ·
                  {page.scope === "global"
                    ? " 全部作品范围"
                    : " 与本人相关的作品范围"}
                </p>
              </div>
            </div>
            {page.items.length ? (
              <ol className="workspace-audit-list">
                {page.items.map((item) => {
                  const workflowChanged =
                    item.fromWorkflowStatus !== item.toWorkflowStatus &&
                    item.toWorkflowStatus;
                  const reviewChanged =
                    item.fromReviewStatus !== item.toReviewStatus &&
                    item.toReviewStatus;
                  return (
                    <li key={item.id}>
                      <header>
                        <div>
                          <Badge>
                            {eventLabels[item.action] ?? item.action}
                          </Badge>
                          <Link to={`/works/${item.workId}`}>
                            {item.workTitle}
                          </Link>
                          <span>· {item.authorName}</span>
                        </div>
                        <time>{dateTime(item.createdAt)}</time>
                      </header>
                      <p>
                        操作人：{item.actorName ?? "系统"}
                        {workflowChanged && (
                          <> · 流程变为 {workflowLabels[workflowChanged]}</>
                        )}
                        {reviewChanged && (
                          <> · 审核变为 {reviewLabels[reviewChanged]}</>
                        )}
                      </p>
                      <details>
                        <summary>查看事件详情</summary>
                        <pre>{JSON.stringify(item.detail, null, 2)}</pre>
                      </details>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <EmptyState
                icon={<Search />}
                title="没有匹配的业务事件"
                description="调整动作、时间范围或搜索词后再试。"
              />
            )}
            <div className="workspace-audit-pagination">
              <Button
                variant="secondary"
                disabled={!previous.length}
                onClick={() => {
                  const next = [...previous];
                  setCursor(next.pop() ?? null);
                  setPrevious(next);
                }}
              >
                上一页
              </Button>
              <Button
                variant="secondary"
                disabled={!page.nextCursor}
                onClick={() => {
                  setPrevious((items) => [...items, cursor]);
                  setCursor(page.nextCursor);
                }}
              >
                下一页
              </Button>
            </div>
          </Surface>
        )}
      </PageState>
    </PermissionGate>
  );
}

export function AuthorsPage() {
  const user = useAccount();
  const action = useAction();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [view, setView] = useState<"cards" | "rows">("cards");
  const query = useInfiniteQuery({
    queryKey: ["authors", search],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await client.GET("/api/authors", {
          params: {
            query: {
              limit: 50,
              search: search.trim() || undefined,
              cursor: pageParam ?? undefined,
            },
          },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  return (
    <PermissionGate permission="authors:read">
      <SectionHeading title="授权作者">
        集中维护授权状态、多平台账号和自动抓取入口。
      </SectionHeading>
      <Toolbar>
        <SearchField
          aria-label="搜索作者"
          placeholder="优先搜索 X @账号，也可搜索作者昵称"
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
            leadingIcon={<Grid2X2 size={15} />}
            onClick={() => setView("cards")}
          >
            卡片
          </Button>
          <Button
            size="sm"
            variant={view === "rows" ? "primary" : "ghost"}
            leadingIcon={<List size={15} />}
            onClick={() => setView("rows")}
          >
            列表
          </Button>
        </div>
        {user.permissions.includes("authors:manage") && (
          <Button
            leadingIcon={<Plus size={16} />}
            onClick={() => setShowCreate(true)}
          >
            新增作者
          </Button>
        )}
      </Toolbar>
      <Feedback error={action.error} success={action.success} />
      {showCreate && (
        <AuthorCreateDialog
          onClose={() => setShowCreate(false)}
          onCompleted={async (message) => {
            await queryClient.invalidateQueries({ queryKey: ["authors"] });
            setShowCreate(false);
            action.setSuccess(message);
          }}
        />
      )}
      {query.isPending ? (
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
          title="暂无作者"
          description="可以使用新增作者或 CSV 批量导入。"
        />
      ) : view === "cards" ? (
        <div className="workspace-card-grid workspace-author-grid">
          {items.map((author) => (
            <AuthorCard key={author.id} author={author} />
          ))}
        </div>
      ) : (
        <Surface className="workspace-author-table-wrap">
          <table className="workspace-author-table">
            <thead>
              <tr>
                <th>作者</th>
                <th>平台账号</th>
                <th>母语</th>
                <th>授权</th>
                <th>标签</th>
              </tr>
            </thead>
            <tbody>
              {items.map((author) => (
                <tr key={author.id}>
                  <td>
                    <Link to={`/authors/${author.id}`}>
                      <AuthorAvatar author={author} />
                      <strong>{author.displayName}</strong>
                    </Link>
                  </td>
                  <td>
                    <div className="workspace-author-platforms">
                      {authorAccountLabel(author)}
                      <PlatformLinks accounts={author.externalAccounts} />
                    </div>
                  </td>
                  <td>{sourceLanguageLabels[author.sourceLanguage]}</td>
                  <td>{authorizationLabels[author.authorizationStatus]}</td>
                  <td>
                    {author.tags.map((tag) => tag.name).join("、") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Surface>
      )}
      {items.length > 0 && (
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
    </PermissionGate>
  );
}

function authorAccountLabel(author: Author) {
  const x = author.externalAccounts.find((account) => account.platform === "x");
  if (x?.handle) return `@${x.handle}`;
  const pixiv = author.externalAccounts.find(
    (account) => account.platform === "pixiv",
  );
  return pixiv?.handle ? `p@${pixiv.handle}` : "尚未关联";
}

function AuthorAvatar({ author }: { author: Author }) {
  const query = useApiQuery(
    ["author-avatar", author.id],
    async () =>
      unwrap(
        await client.GET("/api/authors/{id}/avatar/url", {
          params: { path: { id: author.id } },
        }),
      ),
    author.avatarAvailable,
  );
  return (
    <span className="workspace-avatar workspace-avatar--large">
      {query.data?.url && isDisplayableImageUrl(query.data.url) ? (
        <img src={query.data.url} alt="" loading="lazy" />
      ) : (
        author.displayName.slice(0, 1)
      )}
    </span>
  );
}

function AuthorCard({ author }: { author: Author }) {
  return (
    <Surface className="workspace-author-card">
      <div className="workspace-card-title">
        <AuthorAvatar author={author} />
        <div>
          <h2>
            <Link to={`/authors/${author.id}`}>{author.displayName}</Link>
          </h2>
          <Badge
            tone={
              author.authorizationStatus === "authorized"
                ? "success"
                : "warning"
            }
          >
            {authorizationLabels[author.authorizationStatus]}
          </Badge>
          <Badge>{sourceLanguageLabels[author.sourceLanguage]}</Badge>
        </div>
      </div>
      <div className="workspace-tags">
        {author.tags.map((tag) => (
          <Badge key={tag.id}>{tag.name}</Badge>
        ))}
      </div>
      <p>{authorAccountLabel(author)}</p>
      <PlatformLinks accounts={author.externalAccounts} />
    </Surface>
  );
}

function AuthorCreateDialog({
  onClose,
  onCompleted,
}: {
  onClose: () => void;
  onCompleted: (message: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const action = useAction();
  const [displayName, setDisplayName] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState<SourceLanguage>("ja");
  const [status, setStatus] =
    useState<components["schemas"]["AuthorizationStatus"]>("pending");
  const [tags, setTags] = useState("");
  const [xHandle, setXHandle] = useState("");
  const [xProfile, setXProfile] = useState<ResolvedXProfile | null>(null);
  const [pixivUserId, setPixivUserId] = useState("");
  const [avatar, setAvatar] = useState<File | null>(null);
  const [evidence, setEvidence] = useState<File[]>([]);
  const [preview, setPreview] = useState<AuthorImportPreview | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  async function syncProfile() {
    await action.run(async () => {
      const profile = await unwrap(
        await client.POST("/api/authors/x-profile/resolve", {
          body: { handle: xHandle },
        }),
      );
      setXProfile(profile);
      setXHandle(profile.handle);
      if (!displayName.trim()) setDisplayName(profile.displayName);
      action.setSuccess(
        `已通过 ${sourceAdapterLabels[profile.adapterKey] ?? profile.adapterKey} 同步`,
      );
    });
  }

  async function downloadTemplate() {
    await action.run(async () => {
      const response = await authenticatedFetch("/api/authors/import-template");
      if (!response.ok) throw new Error("批量导入模板下载失败");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "comiku-authors.csv";
      anchor.click();
      URL.revokeObjectURL(url);
    });
  }

  async function previewCsv(file: File | undefined) {
    if (!file) return;
    await action.run(async () => {
      const body = new FormData();
      body.append("file", file);
      const result = await unwrap(
        await client.POST("/api/authors/imports/preview", {
          body: body as never,
        }),
      );
      setPreview(result);
    });
  }

  async function confirmCsv() {
    if (!preview || preview.invalidCount) return;
    await action.run(async () => {
      const result = await unwrap(
        await client.POST("/api/authors/imports", {
          body: { rows: preview.rows },
        }),
      );
      await onCompleted(`已导入 ${result.createdCount} 位作者`);
    });
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await action.run(async () => {
      if (xHandle.trim() && !xProfile) {
        throw new Error("请先同步 X 资料，或清空 X @账号后再创建作者");
      }
      if (pixivUserId.trim() && !/^[1-9][0-9]*$/.test(pixivUserId.trim()))
        throw new Error("Pixiv 用户 ID 必须是主页 /users/ 后的数字");
      let author = await unwrap(
        await client.POST("/api/authors", {
          body: {
            displayName,
            sourceLanguage,
            authorizationStatus: status,
            tagNames: tags
              .split(/[,，]/)
              .map((value) => value.trim())
              .filter(Boolean),
          },
        }),
      );
      if (xProfile) {
        await unwrap(
          await client.POST("/api/authors/{authorId}/accounts", {
            params: { path: { authorId: author.id } },
            body: {
              platform: "x",
              externalUserId: xProfile.externalUserId,
              handle: xProfile.handle,
              profileUrl: xProfile.profileUrl,
              displayNameSnapshot: xProfile.displayName,
              avatarFileObjectId: xProfile.avatarFileObjectId,
              profileSyncAdapter: xProfile.adapterKey,
              profileSyncedAt: xProfile.syncedAt,
              fetchEnabled: true,
              firstSyncMode: "last_24_hours",
            },
          }),
        );
      }
      if (pixivUserId.trim()) {
        await unwrap(
          await client.POST("/api/authors/{authorId}/accounts", {
            params: { path: { authorId: author.id } },
            body: {
              platform: "pixiv",
              externalUserId: pixivUserId.trim(),
              fetchEnabled: false,
              firstSyncMode: "none",
            },
          }),
        );
      }
      if (avatar) {
        await uploadDirect(
          {
            purpose: "author_avatar",
            resourceId: author.id,
            expectedRevision: author.revision,
          },
          [avatar],
        );
        const refreshed = await unwrap(
          await client.GET("/api/authors/{id}", {
            params: { path: { id: author.id } },
          }),
        );
        author = { ...author, revision: refreshed.revision };
      }
      if (evidence.length)
        await uploadDirect(
          {
            purpose: "author_evidence",
            resourceId: author.id,
            expectedRevision: author.revision,
          },
          evidence,
        );
      await onCompleted(
        status === "authorized" && !evidence.length
          ? "作者已创建；建议随后补充授权凭证"
          : "作者已创建",
      );
    });
  }

  return (
    <dialog ref={ref} className="workspace-business-dialog" onCancel={onClose}>
      <header>
        <div>
          <span>作者目录</span>
          <h2>新增作者</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<X size={16} />}
          onClick={onClose}
        >
          关闭
        </Button>
      </header>
      <div className="workspace-dialog-actions">
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<Download size={15} />}
          onClick={() => void downloadTemplate()}
        >
          获取批量导入模板
        </Button>
        <label className="ui-button ui-button--secondary ui-button--sm">
          <Upload size={15} />
          批量导入
          <input
            className="sr-only"
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => void previewCsv(event.target.files?.[0])}
          />
        </label>
      </div>
      {preview ? (
        <section className="workspace-import-preview">
          <p>
            有效 {preview.validCount} 行，错误 {preview.invalidCount} 行。
          </p>
          <div className="workspace-import-table">
            <table>
              <thead>
                <tr>
                  <th>行</th>
                  <th>作者</th>
                  <th>X</th>
                  <th>检查结果</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.row}>
                    <td>{row.row}</td>
                    <td>{row.displayName || "—"}</td>
                    <td>{row.xHandle ? `@${row.xHandle}` : "—"}</td>
                    <td>
                      {row.errors.length ? row.errors.join("；") : "可以导入"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="workspace-dialog-actions">
            <Button variant="ghost" onClick={() => setPreview(null)}>
              返回单个新增
            </Button>
            <Button
              disabled={Boolean(preview.invalidCount)}
              loading={action.busy}
              onClick={() => void confirmCsv()}
            >
              确认整批导入
            </Button>
          </div>
        </section>
      ) : (
        <form
          className="workspace-stacked-form"
          onSubmit={(event) => void create(event)}
        >
          <div className="account-form-row">
            <TextField
              label="X @账号"
              value={xHandle}
              onChange={(event) => {
                setXHandle(event.target.value);
                setXProfile(null);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              loading={action.busy}
              disabled={!xHandle.trim()}
              onClick={() => void syncProfile()}
            >
              同步昵称和头像
            </Button>
          </div>
          {xProfile && (
            <p className="workspace-profile-sync">
              <strong>@{xProfile.handle}</strong>
              <span>{xProfile.displayName}</span>
              {xProfile.avatarUrl && <img src={xProfile.avatarUrl} alt="" />}
            </p>
          )}
          <TextField
            required
            label="作者昵称"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <div className="account-form-row">
            <SelectField
              label="作者母语"
              value={sourceLanguage}
              onValueChange={(value) =>
                setSourceLanguage(value as SourceLanguage)
              }
            >
              <option value="ja">日语</option>
              <option value="ko">韩语</option>
              <option value="en">英语</option>
            </SelectField>
            <SelectField
              label="授权状态"
              value={status}
              onValueChange={(value) => setStatus(value as typeof status)}
            >
              <option value="pending">待确认</option>
              <option value="authorized">已授权</option>
              <option value="expired">已过期</option>
              <option value="revoked">已撤销</option>
            </SelectField>
          </div>
          <TextField
            label="标签"
            hint="使用逗号分隔"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
          />
          <fieldset className="workspace-file-fields">
            <legend>作者头像与授权凭证</legend>
            <label>
              手动头像
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(event) => setAvatar(event.target.files?.[0] ?? null)}
              />
            </label>
            <label>
              授权凭证（可多张）
              <input
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(event) =>
                  setEvidence(Array.from(event.target.files ?? []))
                }
              />
            </label>
          </fieldset>
          <fieldset className="workspace-file-fields">
            <legend>Pixiv 信息账号（可选，不抓取）</legend>
            <TextField
              label="Pixiv 用户 ID"
              hint="主页 /users/123456 中的数字；不是登录账号名。不需要单独填写主页。"
              inputMode="numeric"
              pattern="[1-9][0-9]*"
              value={pixivUserId}
              onChange={(event) => setPixivUserId(event.target.value)}
            />
          </fieldset>
          <Feedback error={action.error} success={action.success} />
          <Button type="submit" loading={action.busy}>
            保存作者
          </Button>
        </form>
      )}
    </dialog>
  );
}

export function AuthorDetailPage() {
  const { id = "" } = useParams();
  const user = useAccount();
  const query = useApiQuery(["author", id], async () =>
    unwrap(await client.GET("/api/authors/{id}", { params: { path: { id } } })),
  );
  const evidence = useApiQuery(
    ["author-evidence", id],
    async () =>
      unwrap(
        await client.GET("/api/authors/{id}/authorization-evidence", {
          params: { path: { id } },
        }),
      ),
    user.permissions.includes("authors:sensitive"),
  );
  return (
    <PermissionGate permission="authors:read">
      <Link className="workspace-back" to="/authors">
        <ArrowLeft size={16} />
        返回作者
      </Link>
      <PageState query={query}>
        {(author) => (
          <>
            <SectionHeading title={author.displayName}>
              作者授权与来源账号
            </SectionHeading>
            <div className="workspace-detail-grid">
              <Surface className="workspace-panel">
                <h2>基本信息</h2>
                <AuthorAvatar author={author} />
                <dl className="workspace-description">
                  <div>
                    <dt>授权状态</dt>
                    <dd>{authorizationLabels[author.authorizationStatus]}</dd>
                  </div>
                  <div>
                    <dt>作者母语</dt>
                    <dd>{sourceLanguageLabels[author.sourceLanguage]}</dd>
                  </div>
                  <div>
                    <dt>标签</dt>
                    <dd>
                      {author.tags.map((tag) => tag.name).join("、") || "—"}
                    </dd>
                  </div>
                </dl>
                {user.permissions.includes("authors:manage") && (
                  <AuthorEditForm key={author.revision} author={author} />
                )}
              </Surface>
              <AuthorAccountsPanel
                authorId={id}
                initialAccounts={author.externalAccounts}
              />
              {user.permissions.includes("authors:sensitive") && (
                <AuthorEvidencePanel
                  author={author}
                  items={evidence.data ?? []}
                  onUpdated={async () => {
                    await Promise.all([query.refetch(), evidence.refetch()]);
                  }}
                />
              )}
            </div>
          </>
        )}
      </PageState>
    </PermissionGate>
  );
}

function AuthorEditForm({ author }: { author: Author }) {
  const action = useAction();
  const [displayName, setDisplayName] = useState(author.displayName);
  const [status, setStatus] = useState(author.authorizationStatus);
  const [sourceLanguage, setSourceLanguage] = useState(author.sourceLanguage);
  const [tags, setTags] = useState(
    author.tags.map((tag) => tag.name).join("，"),
  );
  const [avatar, setAvatar] = useState<File | null>(null);
  async function save(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      const saved = await unwrap(
        await client.PATCH("/api/authors/{id}", {
          params: { path: { id: author.id } },
          body: {
            displayName,
            sourceLanguage,
            authorizationStatus: status,
            tagNames: tags
              .split(/[,，]/)
              .map((item) => item.trim())
              .filter(Boolean),
            expectedRevision: author.revision,
          },
        }),
      );
      if (avatar) {
        await uploadDirect(
          {
            purpose: "author_avatar",
            resourceId: author.id,
            expectedRevision: saved.revision,
          },
          [avatar],
        );
        queryClient.removeQueries({ queryKey: ["author-avatar", author.id] });
      }
      await queryClient.invalidateQueries({ queryKey: ["author", author.id] });
      await queryClient.invalidateQueries({ queryKey: ["authors"] });
      action.setSuccess("作者信息已保存");
    });
  }
  return (
    <form
      className="workspace-stacked-form"
      onSubmit={(event) => void save(event)}
    >
      <h3>编辑作者</h3>
      <TextField
        required
        label="作者昵称"
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
      />
      <SelectField
        label="作者母语"
        value={sourceLanguage}
        onValueChange={(value) => setSourceLanguage(value as SourceLanguage)}
      >
        <option value="ja">日语</option>
        <option value="ko">韩语</option>
        <option value="en">英语</option>
      </SelectField>
      <SelectField
        label="授权状态"
        value={status}
        onValueChange={(value) => setStatus(value as typeof status)}
      >
        <option value="pending">待确认</option>
        <option value="authorized">已授权</option>
        <option value="expired">已过期</option>
        <option value="revoked">已撤销</option>
      </SelectField>
      <TextField
        label="标签"
        value={tags}
        onChange={(event) => setTags(event.target.value)}
      />
      <label>
        手动头像（可选）
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(event) => setAvatar(event.target.files?.[0] ?? null)}
        />
      </label>
      <Feedback error={action.error} success={action.success} />
      <Button size="sm" type="submit" loading={action.busy}>
        保存作者
      </Button>
    </form>
  );
}

function AuthorEvidencePanel({
  author,
  items,
  onUpdated,
}: {
  author: Author;
  items: components["schemas"]["AuthorEvidenceDto"][];
  onUpdated: () => Promise<unknown>;
}) {
  const action = useAction();
  const [files, setFiles] = useState<File[]>([]);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!files.length) return;
    const form = event.currentTarget;
    await action.run(async () => {
      await uploadDirect(
        {
          purpose: "author_evidence",
          resourceId: author.id,
          expectedRevision: author.revision,
        },
        files,
      );
      setFiles([]);
      form.reset();
      await onUpdated();
      action.setSuccess("授权凭证已上传");
    });
  }
  async function move(index: number, offset: number) {
    const next = index + offset;
    if (next < 0 || next >= items.length) return;
    const evidenceIds = items.map((item) => item.id);
    [evidenceIds[index], evidenceIds[next]] = [
      evidenceIds[next],
      evidenceIds[index],
    ];
    await action.run(async () => {
      await unwrap(
        await client.PATCH("/api/authors/{id}/authorization-evidence/order", {
          params: { path: { id: author.id } },
          body: { evidenceIds, expectedRevision: author.revision },
        }),
      );
      await onUpdated();
    });
  }
  return (
    <Surface className="workspace-panel workspace-evidence-panel">
      <details>
        <summary>
          <span>授权凭证</span>
          <Badge tone={items.length ? "success" : "warning"}>
            {items.length ? `${items.length} 张` : "待补充"}
          </Badge>
        </summary>
        {items.length ? (
          <div className="workspace-evidence-grid">
            {items.map((item, index) => (
              <figure key={item.id}>
                <img src={item.url} alt={`授权凭证 ${index + 1}`} />
                <figcaption>
                  <span>{Math.ceil(item.size / 1024)} KiB</span>
                  <span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={index === 0}
                      onClick={() => void move(index, -1)}
                    >
                      <ArrowUp size={14} />
                      上移
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={index === items.length - 1}
                      onClick={() => void move(index, 1)}
                    >
                      <ArrowDown size={14} />
                      下移
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() =>
                        void action.run(async () => {
                          await unwrap(
                            await client.DELETE(
                              "/api/authors/{id}/authorization-evidence/{evidenceId}",
                              {
                                params: {
                                  path: { id: author.id, evidenceId: item.id },
                                },
                                body: { expectedRevision: author.revision },
                              },
                            ),
                          );
                          await onUpdated();
                          action.setSuccess("授权凭证已移除");
                        })
                      }
                    >
                      移除
                    </Button>
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <p className="workspace-muted">
            有效授权尚未附凭证，不阻塞维护，但建议尽快补充。
          </p>
        )}
        <form
          className="workspace-stacked-form"
          onSubmit={(event) => void upload(event)}
        >
          <label>
            添加凭证图片
            <input
              required
              multiple
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(event) =>
                setFiles(Array.from(event.target.files ?? []))
              }
            />
          </label>
          <Feedback error={action.error} success={action.success} />
          <Button type="submit" size="sm" loading={action.busy}>
            上传凭证
          </Button>
        </form>
      </details>
    </Surface>
  );
}

function CandidateCover({ candidate }: { candidate: Candidate }) {
  const media = candidate.media[0];
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxMedia =
    lightboxIndex === null ? undefined : candidate.media[lightboxIndex];
  const query = useImageUrl(
    ["thumbnail", "candidate-media", candidate.id, media?.id],
    async () =>
      unwrap(
        await client.GET("/api/candidates/{candidateId}/media/{mediaId}/url", {
          params: {
            path: { candidateId: candidate.id, mediaId: media!.id },
            query: { variant: "thumbnail" },
          },
        }),
      ),
    Boolean(media),
  );
  const lightboxQuery = useImageUrl(
    ["candidate-media", candidate.id, lightboxMedia?.id],
    async () =>
      unwrap(
        await client.GET("/api/candidates/{candidateId}/media/{mediaId}/url", {
          params: {
            path: { candidateId: candidate.id, mediaId: lightboxMedia!.id },
          },
        }),
      ),
    Boolean(lightboxMedia),
  );
  const safe = isDisplayableImageUrl(query.data?.url);
  return (
    <>
      <button
        type="button"
        className="workspace-cover workspace-cover-button"
        aria-label={`查看 ${candidate.authorName} 的图片组大图`}
        onClick={() => setLightboxIndex(0)}
      >
        {safe ? (
          <img src={query.data!.url!} alt="" loading="lazy" />
        ) : (
          <ImageIcon aria-hidden="true" />
        )}
        <Badge>{candidate.media.length} P</Badge>
      </button>
      {lightboxIndex !== null && (
        <ImageLightbox
          src={
            isDisplayableImageUrl(lightboxQuery.data?.url)
              ? lightboxQuery.data!.url
              : undefined
          }
          alt={`${candidate.authorName} 的候选图片第 ${lightboxIndex + 1} 页`}
          index={lightboxIndex}
          count={candidate.media.length}
          thumbnailSrc={
            lightboxIndex === 0 && isDisplayableImageUrl(query.data?.url)
              ? query.data!.url
              : undefined
          }
          loading={lightboxQuery.isPending}
          onClose={() => setLightboxIndex(null)}
          onPrevious={
            lightboxIndex > 0
              ? () => setLightboxIndex((value) => (value ?? 1) - 1)
              : undefined
          }
          onNext={
            lightboxIndex < candidate.media.length - 1
              ? () => setLightboxIndex((value) => (value ?? -1) + 1)
              : undefined
          }
        />
      )}
    </>
  );
}

function CandidateMediaThumbnail({
  candidateId,
  media,
}: {
  candidateId: string;
  media: Candidate["media"][number];
}) {
  const query = useImageUrl(
    ["thumbnail", "candidate-media", candidateId, media.id],
    async () =>
      unwrap(
        await client.GET("/api/candidates/{candidateId}/media/{mediaId}/url", {
          params: {
            path: { candidateId, mediaId: media.id },
            query: { variant: "thumbnail" },
          },
        }),
      ),
  );
  const sourceName = media.externalMediaId.replace(/^\d+:/, "");
  return (
    <div className="candidate-order-item">
      <div className="candidate-order-preview">
        {query.data?.url ? (
          <img src={query.data.url} alt="" loading="lazy" />
        ) : (
          <ImageIcon aria-hidden="true" />
        )}
      </div>
      <span title={sourceName}>{sourceName}</span>
    </div>
  );
}

function CandidateOrderPanel({
  candidate,
  onSaved,
}: {
  candidate: Candidate;
  onSaved: () => Promise<unknown>;
}) {
  const action = useAction();
  const [media, setMedia] = useState(candidate.media);
  useEffect(() => setMedia(candidate.media), [candidate.media]);
  function move(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= media.length) return;
    setMedia((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  async function save() {
    await action.run(async () => {
      await unwrap(
        await client.POST("/api/candidates/{id}/media-order", {
          params: { path: { id: candidate.id } },
          body: {
            expectedRevision: candidate.revision,
            mediaIds: media.map((item) => item.id),
          },
        }),
      );
      await onSaved();
      action.setSuccess("图片顺序已保存");
    });
  }
  return (
    <div className="candidate-order-panel">
      <p>从上到下为入库后的图片顺序。</p>
      <div className="candidate-order-list">
        {media.map((item, index) => (
          <div className="candidate-order-row" key={item.id}>
            <b>{index + 1}</b>
            <CandidateMediaThumbnail candidateId={candidate.id} media={item} />
            <div className="candidate-order-actions">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={index === 0}
                leadingIcon={<ArrowUp size={15} />}
                onClick={() => move(index, -1)}
              >
                上移
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={index === media.length - 1}
                leadingIcon={<ArrowDown size={15} />}
                onClick={() => move(index, 1)}
              >
                下移
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Feedback error={action.error} success={action.success} />
      <Button size="sm" loading={action.busy} onClick={() => void save()}>
        保存顺序
      </Button>
    </div>
  );
}

const pendingCandidateUploadSessionKey =
  "comiku.pending-candidate-upload-session";

function storedCandidateUploadSessionId() {
  try {
    return window.localStorage.getItem(pendingCandidateUploadSessionKey);
  } catch {
    return null;
  }
}

function storeCandidateUploadSessionId(id: string | null) {
  try {
    if (id) window.localStorage.setItem(pendingCandidateUploadSessionKey, id);
    else window.localStorage.removeItem(pendingCandidateUploadSessionKey);
  } catch {
    // Upload still works when browser storage is unavailable.
  }
}

function uploadSessionSummary(result: CandidateUploadSession) {
  const created = result.items.filter((item) => item.status === "created");
  const failed = result.items.filter((item) => item.status === "failed");
  return failed.length
    ? `已创建 ${created.length} 个候选组，${failed.length} 个文件失败：${failed
        .map((item) => item.sourceName + "（" + item.message + "）")
        .join("；")}`
    : `已创建 ${created.length} 个候选组`;
}

function ManualCandidateUpload({
  onUploaded,
  onClose,
}: {
  onUploaded: () => Promise<unknown>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const action = useAction();
  const [authorId, setAuthorId] = useState("");
  const [text, setText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState("");
  const [uploadProblems, setUploadProblems] = useState<Record<string, string>>(
    {},
  );
  const [destination, setDestination] = useState<"direct" | "candidate">(
    "direct",
  );
  const [completed, setCompleted] = useState<CandidateUploadSession | null>(
    null,
  );
  const [drafts, setDrafts] = useState<
    Record<
      string,
      {
        authorId: string;
        text: string;
        sourceUrl: string;
        media: Candidate["media"];
        originalMediaIds: string[];
      }
    >
  >({});
  const [recoverableSessionId, setRecoverableSessionId] = useState(
    storedCandidateUploadSessionId,
  );
  const authors = useApiQuery(["authors", "manual-upload"], async () =>
    unwrap(await client.GET("/api/authors")),
  );
  const availableAuthors = (authors.data?.items ?? []).filter(
    (author) => author.authorizationStatus === "authorized",
  );
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    };
  }, []);
  useEffect(() => {
    if (!authorId && availableAuthors[0]) setAuthorId(availableAuthors[0].id);
  }, [authorId, availableAuthors]);

  function applyCompletedSession(result: CandidateUploadSession) {
    setCompleted(result);
    setDrafts(
      Object.fromEntries(
        result.items.flatMap((item) =>
          item.candidate
            ? [
                [
                  item.candidate.id,
                  {
                    authorId: item.candidate.authorId,
                    text: item.candidate.text ?? "",
                    sourceUrl: item.candidate.externalPostUrl ?? "",
                    media: item.candidate.media,
                    originalMediaIds: item.candidate.media.map(
                      (media) => media.id,
                    ),
                  },
                ],
              ]
            : [],
        ),
      ),
    );
    storeCandidateUploadSessionId(null);
    setRecoverableSessionId(null);
    setProgress("");
    action.setSuccess(`${uploadSessionSummary(result)}，请确认入库目标`);
  }

  function contentType(file: File): CandidateUploadContentType {
    if (
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
    ) {
      return file.type as CandidateUploadContentType;
    }
    if (file.name.toLowerCase().endsWith(".zip")) return "application/zip";
    const extension = file.name.toLowerCase().split(".").at(-1);
    const inferred = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
    }[extension ?? ""];
    if (!inferred) throw new Error(`无法识别文件类型：${file.name}`);
    return inferred as CandidateUploadContentType;
  }

  async function checksum(file: File) {
    const bytes =
      typeof file.arrayBuffer === "function"
        ? await file.arrayBuffer()
        : await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () =>
              reject(new Error(`无法读取文件：${file.name}`));
            reader.onload = () => {
              if (reader.result instanceof ArrayBuffer) resolve(reader.result);
              else reject(new Error(`无法读取文件：${file.name}`));
            };
            reader.readAsArrayBuffer(file);
          });
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function finishSession(sessionId: string) {
    const queued = await unwrap(
      await client.POST("/api/candidates/upload-sessions/{id}/finalize", {
        params: { path: { id: sessionId } },
      }),
    );
    const result = await pollTransfer(
      queued,
      async () =>
        unwrap(
          await client.GET("/api/candidates/upload-sessions/{id}", {
            params: { path: { id: sessionId } },
          }),
        ),
      ["finalizing"],
    );
    applyCompletedSession(result);
  }

  async function resumeSession() {
    if (!recoverableSessionId) return;
    await action.run(async () => {
      setProgress("正在恢复上次上传会话…");
      const session = await unwrap(
        await client.GET("/api/candidates/upload-sessions/{id}", {
          params: { path: { id: recoverableSessionId } },
        }),
      );
      if (session.status === "expired") {
        storeCandidateUploadSessionId(null);
        setRecoverableSessionId(null);
        setProgress("");
        throw new Error("上次上传会话已过期，请重新选择文件");
      }
      if (session.status === "finalizing") {
        await finishSession(session.id);
        return;
      }
      if (session.status === "completed") {
        applyCompletedSession(session);
        return;
      }
      setProgress("正在校验已上传文件并建立候选组…");
      await finishSession(session.id);
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authorId || !files.length) return;
    await action.run(async () => {
      setProgress("正在计算文件校验值…");
      const descriptors = await Promise.all(
        files.map(async (file) => ({
          sourceName: file.name,
          contentType: contentType(file),
          size: file.size,
          checksum: await checksum(file),
        })),
      );
      setProgress("正在创建安全上传会话…");
      const session = await unwrap(
        await client.POST("/api/candidates/upload-sessions", {
          body: {
            authorId,
            ...(text.trim() ? { text: text.trim() } : {}),
            ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
            files: descriptors,
          },
        }),
      );
      storeCandidateUploadSessionId(session.id);
      setRecoverableSessionId(session.id);
      const problems: Record<string, string> = {};
      for (const [index, file] of files.entries()) {
        const item = session.items[index];
        if (!item?.upload) continue;
        setProgress(`正在上传 ${index + 1}/${files.length}：${file.name}`);
        try {
          const response = await authenticatedFetch(item.upload.url, {
            method: item.upload.method,
            headers: item.upload.headers,
            body: file,
          });
          if (!response.ok) {
            problems[item.id] =
              response.status === 401 || response.status === 403
                ? "上传签名已失效，请重新选择文件"
                : `文件上传失败（HTTP ${response.status}），请重试`;
            continue;
          }
        } catch {
          problems[item.id] = "文件上传网络失败，请检查连接后重试";
        }
      }
      setUploadProblems(problems);
      setProgress("正在校验并建立候选组…");
      await finishSession(session.id);
    });
  }

  function updateDraft(
    candidateId: string,
    change: Partial<(typeof drafts)[string]>,
  ) {
    setDrafts((current) => ({
      ...current,
      [candidateId]: { ...current[candidateId], ...change },
    }));
  }

  function movePreview(candidateId: string, index: number, offset: -1 | 1) {
    const draft = drafts[candidateId];
    if (!draft) return;
    const media = [...draft.media];
    const target = index + offset;
    if (target < 0 || target >= media.length) return;
    [media[index], media[target]] = [media[target], media[index]];
    updateDraft(candidateId, { media });
  }

  async function confirmUpload() {
    if (!completed) return;
    await action.run(async () => {
      const candidates: Candidate[] = [];
      for (const item of completed.items) {
        if (!item.candidate) continue;
        const draft = drafts[item.candidate.id];
        if (!draft) continue;
        let current = item.candidate;
        const mediaIds = draft.media.map((media) => media.id);
        if (
          mediaIds.some((id, index) => id !== draft.originalMediaIds[index])
        ) {
          current = await unwrap(
            await client.POST("/api/candidates/{id}/media-order", {
              params: { path: { id: current.id } },
              body: { expectedRevision: current.revision, mediaIds },
            }),
          );
        }
        if (
          draft.authorId !== current.authorId ||
          draft.text.trim() !== (current.text ?? "") ||
          draft.sourceUrl.trim() !== (current.externalPostUrl ?? "")
        ) {
          current = await unwrap(
            await client.PATCH("/api/candidates/{id}/manual-metadata", {
              params: { path: { id: current.id } },
              body: {
                authorId: draft.authorId,
                text: draft.text.trim() || null,
                sourceUrl: draft.sourceUrl.trim() || null,
                expectedRevision: current.revision,
              },
            }),
          );
        }
        candidates.push(current);
      }
      if (destination === "direct" && candidates.length) {
        const result = await unwrap(
          await client.POST("/api/candidates/actions", {
            body: {
              action: "import",
              items: candidates.map((candidate) => ({
                id: candidate.id,
                expectedRevision: candidate.revision,
              })),
            },
          }),
        );
        const failures = result.results.filter(
          (item) => !["succeeded", "unchanged"].includes(item.outcome),
        );
        if (failures.length) {
          throw new Error(
            `${failures.length} 个图组未能直接入库，请在候选池检查`,
          );
        }
      }
      await onUploaded();
      onClose();
    });
  }
  return (
    <dialog
      ref={dialogRef}
      className="workspace-business-dialog workspace-upload-dialog"
      onCancel={onClose}
    >
      <header>
        <div>
          <span>图源导入</span>
          <h2>手动上传图源</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          关闭
        </Button>
      </header>
      {completed ? (
        <section className="workspace-upload-preview">
          <p>
            检查每个图组的作者、原帖配文和页序；裸图各自成组，ZIP
            内图片保持为同一组。
          </p>
          {completed.items.map((item) => {
            const candidate = item.candidate;
            const draft = candidate ? drafts[candidate.id] : null;
            if (!candidate || !draft) {
              return item.status === "failed" ? (
                <p className="account-error" key={item.id}>
                  {item.sourceName}：{uploadProblems[item.id] ?? item.message}
                </p>
              ) : null;
            }
            return (
              <Surface key={candidate.id} variant="soft">
                <div className="workspace-upload-preview-heading">
                  <strong>{item.sourceName}</strong>
                  <Badge>{draft.media.length} 页</Badge>
                </div>
                <div className="workspace-upload-preview-fields">
                  <SelectField
                    label="授权作者"
                    value={draft.authorId}
                    onValueChange={(value) =>
                      updateDraft(candidate.id, { authorId: value })
                    }
                  >
                    {availableAuthors.map((author) => (
                      <option key={author.id} value={author.id}>
                        {author.displayName}
                      </option>
                    ))}
                  </SelectField>
                  <TextField
                    label="原帖配文（可选）"
                    value={draft.text}
                    maxLength={4000}
                    onChange={(event) =>
                      updateDraft(candidate.id, { text: event.target.value })
                    }
                  />
                  <TextField
                    label="来源链接（可选）"
                    type="url"
                    value={draft.sourceUrl}
                    onChange={(event) =>
                      updateDraft(candidate.id, {
                        sourceUrl: event.target.value,
                      })
                    }
                  />
                </div>
                <div className="workspace-upload-page-order">
                  {draft.media.map((media, index) => (
                    <div key={media.id}>
                      <CandidateMediaThumbnail
                        candidateId={candidate.id}
                        media={media}
                      />
                      <span>{index + 1}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={index === 0}
                        onClick={() => movePreview(candidate.id, index, -1)}
                      >
                        前移
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={index === draft.media.length - 1}
                        onClick={() => movePreview(candidate.id, index, 1)}
                      >
                        后移
                      </Button>
                    </div>
                  ))}
                </div>
              </Surface>
            );
          })}
          <SelectField
            label="完成后"
            value={destination}
            onValueChange={(value) =>
              setDestination(value as "direct" | "candidate")
            }
          >
            <option value="direct">直接入库（默认）</option>
            <option value="candidate">进入候选池</option>
          </SelectField>
          <Feedback error={action.error} success={action.success} />
          <div className="workspace-dialog-actions">
            <Button
              loading={action.busy}
              disabled={!completed.items.some((item) => item.candidate)}
              onClick={() => void confirmUpload()}
            >
              确认{destination === "direct" ? "并直接入库" : "进入候选池"}
            </Button>
          </div>
        </section>
      ) : (
        <form
          className="workspace-stacked-form"
          onSubmit={(event) => void submit(event)}
        >
          <p>
            每张裸图单独形成图组；每个 ZIP 形成一个多页图组。ZIP
            最多读取两层目录，统一的末尾 -1/-01 编号会自动排序。
          </p>
          <SelectField
            label="授权作者"
            value={authorId}
            required
            onValueChange={setAuthorId}
          >
            <option value="">请选择作者</option>
            {availableAuthors.map((author) => (
              <option key={author.id} value={author.id}>
                {author.displayName}
              </option>
            ))}
          </SelectField>
          <TextField
            label="原帖配文（可选）"
            value={text}
            maxLength={4000}
            onChange={(event) => setText(event.target.value)}
          />
          <TextField
            label="来源链接（可选）"
            type="url"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
          />
          <label className="workspace-file-field">
            <span>图片或 ZIP</span>
            <input
              type="file"
              aria-label="图片或 ZIP"
              accept=".zip,image/png,image/jpeg,image/webp,image/gif"
              multiple
              required
              onChange={(event) =>
                setFiles(Array.from(event.currentTarget.files ?? []))
              }
            />
            <small>
              最多 20 个文件，每个不超过 25 MiB；单个 ZIP 最多 100 张图片。
            </small>
          </label>
          <Feedback error={action.error} success={action.success} />
          {progress && <p className="workspace-muted">{progress}</p>}
          {recoverableSessionId && !progress && (
            <div className="workspace-inline-actions">
              <span className="workspace-muted">
                发现上次未收口的上传会话。
              </span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={action.busy}
                onClick={() => void resumeSession()}
              >
                恢复处理
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={action.busy}
                onClick={() => {
                  storeCandidateUploadSessionId(null);
                  setRecoverableSessionId(null);
                }}
              >
                放弃记录
              </Button>
            </div>
          )}
          {!availableAuthors.length && !authors.isPending && (
            <p className="account-error">请先创建至少一位授权有效的作者。</p>
          )}
          <Button
            type="submit"
            loading={action.busy}
            disabled={!authorId || !files.length}
            leadingIcon={<Upload size={16} />}
          >
            上传并预览图组
          </Button>
        </form>
      )}
    </dialog>
  );
}

function CandidateTagGroupPanel() {
  const action = useAction();
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [editing, setEditing] = useState<CandidateTagGroup | null>(null);
  const [kind, setKind] =
    useState<components["schemas"]["CandidateTagGroupKind"]>("valid");
  const query = useApiQuery(["candidate-tag-groups"], async () =>
    unwrap(await client.GET("/api/candidates/tag-groups")),
  );

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await action.run(async () => {
      const values = aliases
        .split(/[,，\s]+/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (editing) {
        await unwrap(
          await client.PATCH("/api/candidates/tag-groups/{id}", {
            params: { path: { id: editing.id } },
            body: {
              name,
              kind,
              enabled: editing.enabled,
              aliases: values,
              expectedRevision: editing.revision,
            },
          }),
        );
      } else {
        await unwrap(
          await client.POST("/api/candidates/tag-groups", {
            body: { name, kind, enabled: true, aliases: values },
          }),
        );
      }
      setName("");
      setAliases("");
      setEditing(null);
      await Promise.all([
        query.refetch(),
        queryClient.invalidateQueries({ queryKey: ["candidates"] }),
      ]);
      action.setSuccess("标签组已保存，候选优先级已重新计算");
    });
  }

  async function toggle(group: CandidateTagGroup) {
    await action.run(async () => {
      await unwrap(
        await client.PATCH("/api/candidates/tag-groups/{id}", {
          params: { path: { id: group.id } },
          body: {
            name: group.name,
            kind: group.kind,
            enabled: !group.enabled,
            aliases: group.aliases,
            expectedRevision: group.revision,
          },
        }),
      );
      await Promise.all([
        query.refetch(),
        queryClient.invalidateQueries({ queryKey: ["candidates"] }),
      ]);
      action.setSuccess(group.enabled ? "标签组已停用" : "标签组已启用");
    });
  }

  return (
    <Surface className="workspace-tag-groups" variant="soft">
      <div className="workspace-panel-heading">
        <div>
          <h2>候选标签规则</h2>
          <p>只有命中已启用“有效作品标签”组的候选会优先显示。</p>
        </div>
      </div>
      <form onSubmit={(event) => void save(event)}>
        <TextField
          label="标签组名称"
          value={name}
          required
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
        <SelectField
          label="规则类型"
          value={kind}
          onValueChange={(value) =>
            setKind(value as components["schemas"]["CandidateTagGroupKind"])
          }
        >
          <option value="valid">有效作品标签</option>
          <option value="gray">灰名单</option>
          <option value="blocked">排除标签</option>
        </SelectField>
        <TextField
          label="标签别名"
          value={aliases}
          required
          placeholder="#ブルアカ，#블루아카，#BlueArchive"
          onChange={(event) => setAliases(event.target.value)}
        />
        <div className="workspace-inline-actions">
          <Button type="submit" size="sm" loading={action.busy}>
            {editing ? "保存修改" : "新增标签组"}
          </Button>
          {editing && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(null);
                setName("");
                setAliases("");
                setKind("valid");
              }}
            >
              取消
            </Button>
          )}
        </div>
      </form>
      <Feedback error={action.error} success={action.success} />
      <PageState query={query} empty={(groups) => !groups.length}>
        {(groups) => (
          <ul className="workspace-tag-group-list">
            {groups.map((group) => (
              <li key={group.id}>
                <div>
                  <strong>{group.name}</strong>
                  <span>
                    {candidateTagGroupLabels[group.kind]} ·{" "}
                    {group.aliases.join("、")}
                  </span>
                </div>
                <div className="workspace-inline-actions">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={action.busy}
                    onClick={() => {
                      setEditing(group);
                      setName(group.name);
                      setAliases(group.aliases.join("，"));
                      setKind(group.kind);
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    loading={action.busy}
                    onClick={() => void toggle(group)}
                  >
                    {group.enabled ? "停用" : "启用"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PageState>
    </Surface>
  );
}

type CandidateTriageGroup =
  "valid_manga" | "neutral_manga" | "blocked_manga" | "photo";

const candidateTriageSections: {
  value: CandidateTriageGroup;
  title: string;
  description: string;
}[] = [
  {
    value: "valid_manga",
    title: "有效标签漫画 / 插画",
    description: "命中配置的作品标签或模型确认，优先审核。",
  },
  {
    value: "neutral_manga",
    title: "普通漫画 / 插画",
    description: "未命中有效标签或模型确认，保留人工判断。",
  },
  {
    value: "blocked_manga",
    title: "黑名单标签漫画 / 插画",
    description: "命中排除标签，仍保留人工判断入口。",
  },
  {
    value: "photo",
    title: "现实照片",
    description: "人工或分类器标记为照片，统一排在最后。",
  },
];

function CandidateAuthorIdentity({ candidate }: { candidate: Candidate }) {
  const avatar = useApiQuery(
    ["candidate-author-avatar", candidate.authorId],
    async () =>
      unwrap(
        await client.GET("/api/authors/{id}/avatar/url", {
          params: { path: { id: candidate.authorId } },
        }),
      ),
    candidate.authorAvatarAvailable,
  );
  return (
    <div className="workspace-candidate-author">
      <span className="workspace-author-avatar">
        {avatar.data?.url ? (
          <img src={avatar.data.url} alt="" />
        ) : (
          candidate.authorName.slice(0, 1).toUpperCase()
        )}
      </span>
      <div>
        <h2>{candidate.authorName}</h2>
        <span>
          {candidate.authorHandle
            ? `${candidate.platform === "pixiv" ? "p@" : "@"}${candidate.authorHandle}`
            : candidate.platform}
        </span>
      </div>
    </div>
  );
}

function CandidateGridSection({
  status,
  group,
  language,
  fetchedRange,
  search,
  selected,
  onToggle,
  onSelectLoaded,
  onClassify,
  onRetryAnalysis,
  orderingCandidateId,
  onToggleOrdering,
}: {
  status: components["schemas"]["CandidateStatus"];
  group?: CandidateTriageGroup;
  language: SourceLanguage | "all";
  fetchedRange: string;
  search: string;
  selected: Record<string, number>;
  onToggle: (candidate: Candidate) => void;
  onSelectLoaded: (candidates: Candidate[]) => void;
  onClassify: (
    candidate: Candidate,
    label: components["schemas"]["CandidateVisualClass"],
  ) => void;
  onRetryAnalysis: (candidate: Candidate) => void;
  orderingCandidateId: string | null;
  onToggleOrdering: (id: string) => void;
}) {
  const user = useAccount();
  const query = useInfiniteQuery({
    queryKey: [
      "candidates",
      status,
      group ?? "timeline",
      language,
      fetchedRange,
      search,
    ],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await client.GET("/api/candidates", {
          params: {
            query: {
              status,
              ...(group ? { triageGroup: group } : {}),
              ...(language === "all" ? {} : { sourceLanguage: language }),
              ...(search.trim() ? { search: search.trim() } : {}),
              ...(fetchedRange === "all"
                ? {}
                : {
                    fetchedAfter: new Date(
                      Date.now() - Number(fetchedRange) * 24 * 60 * 60 * 1000,
                    ).toISOString(),
                  }),
              cursor: pageParam ?? undefined,
              limit: 24,
            },
          },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const section = candidateTriageSections.find((item) => item.value === group);
  const content = (
    <>
      {items.length ? (
        <div className="workspace-card-grid workspace-media-grid">
          {items.map((candidate) => (
            <Surface className="workspace-media-card" key={candidate.id}>
              <CandidateCover candidate={candidate} />
              <div className="workspace-card-body">
                <div className="workspace-card-title">
                  <CandidateAuthorIdentity candidate={candidate} />
                  <Badge
                    tone={
                      candidate.status === "pending"
                        ? "warning"
                        : candidate.status === "imported"
                          ? "success"
                          : "neutral"
                    }
                  >
                    {candidateLabels[candidate.status]}
                  </Badge>
                </div>
                <p>{candidate.text || "此原帖没有文字说明。"}</p>
                <div className="workspace-tags">
                  <Badge
                    tone={
                      candidate.tagDisposition === "valid" ||
                      (candidate.tagDisposition === "neutral" &&
                        group === "valid_manga")
                        ? "success"
                        : candidate.tagDisposition === "blocked"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {candidate.tagDisposition === "valid"
                      ? "有效标签"
                      : candidate.tagDisposition === "blocked"
                        ? "黑名单标签"
                        : group === "valid_manga"
                          ? "模型命中"
                          : "普通标签"}
                  </Badge>
                  <Badge>
                    {sourceLanguageLabels[candidate.sourceLanguage]}
                  </Badge>
                  {candidate.hashtags.map((tag) => (
                    <Badge key={tag}>#{tag}</Badge>
                  ))}
                  {(candidate.reviewPriority === "unprocessed" ||
                    candidate.reviewPriority === "queued" ||
                    candidate.reviewPriority === "failed") && (
                    <Badge>
                      {
                        {
                          unprocessed: "未识别",
                          queued: "待识别",
                          failed: "识别失败",
                        }[candidate.reviewPriority]
                      }
                    </Badge>
                  )}
                </div>
                <footer>
                  {user.permissions.includes("candidates:manage") && (
                    <label className="account-checkbox">
                      <input
                        type="checkbox"
                        checked={candidate.id in selected}
                        onChange={() => onToggle(candidate)}
                      />
                      选择
                    </label>
                  )}
                  {candidate.externalPostUrl && (
                    <a
                      href={candidate.externalPostUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      原帖 <ExternalLink size={14} />
                    </a>
                  )}
                  {candidate.status === "pending" &&
                    candidate.media.length > 1 &&
                    user.permissions.includes("candidates:manage") && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        leadingIcon={<Images size={15} />}
                        onClick={() => onToggleOrdering(candidate.id)}
                      >
                        图片顺序
                      </Button>
                    )}
                  {user.permissions.includes("candidates:manage") && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        onClassify(
                          candidate,
                          candidate.visualClass === "photo" ? "manga" : "photo",
                        )
                      }
                    >
                      {candidate.visualClass === "photo"
                        ? "恢复为漫画 / 插画"
                        : "标记为照片"}
                    </Button>
                  )}
                  {candidate.reviewPriority === "failed" &&
                    user.permissions.includes("candidates:manage") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onRetryAnalysis(candidate)}
                      >
                        重试识别
                      </Button>
                    )}
                </footer>
                {orderingCandidateId === candidate.id && (
                  <CandidateOrderPanel
                    candidate={candidate}
                    onSaved={async () => {
                      onToggleOrdering(candidate.id);
                      await queryClient.invalidateQueries({
                        queryKey: ["candidates"],
                      });
                    }}
                  />
                )}
              </div>
            </Surface>
          ))}
        </div>
      ) : !query.isPending ? (
        <EmptyState
          icon={<Inbox />}
          title="这个区域暂时没有候选"
          description="调整检索条件或抓取新内容后再查看。"
        />
      ) : null}
      {query.hasNextPage && (
        <Button
          variant="secondary"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          再加载 24 个
        </Button>
      )}
    </>
  );
  if (!section) return <PageState query={query}>{() => content}</PageState>;
  return (
    <details className="workspace-candidate-section" open>
      <summary>
        <span>
          <strong>{section.title}</strong>
          <small>{section.description}</small>
        </span>
        <Badge>{total}</Badge>
      </summary>
      {user.permissions.includes("candidates:manage") && (
        <div className="workspace-candidate-section-actions">
          <Button
            size="sm"
            variant="ghost"
            disabled={!items.length}
            onClick={() => onSelectLoaded(items)}
          >
            选择当前已加载内容
          </Button>
        </div>
      )}
      <PageState query={query}>{() => content}</PageState>
    </details>
  );
}

export function CandidatesPage() {
  const user = useAccount();
  const action = useAction();
  useCandidateAnalysisRefresh();
  const [sourceRunId, setSourceRunId] = useState<string | null>(null);
  const sourceRun = useQuery({
    queryKey: ["source-fetch", sourceRunId],
    enabled: Boolean(sourceRunId),
    queryFn: async () =>
      unwrap(
        await client.GET("/api/source-fetch/runs/{id}", {
          params: { path: { id: sourceRunId! } },
        }),
      ),
    refetchInterval: (query) =>
      query.state.data &&
      ["queued", "running"].includes(query.state.data.status)
        ? 2_000
        : false,
  });
  const sourceActive = Boolean(
    sourceRunId &&
    (!sourceRun.data || ["queued", "running"].includes(sourceRun.data.status)),
  );
  useEffect(() => {
    if (
      !sourceRun.data ||
      ["queued", "running"].includes(sourceRun.data.status)
    )
      return;
    void queryClient.invalidateQueries({ queryKey: ["candidates"] });
  }, [sourceRun.data]);
  const [status, setStatus] = useState("pending");
  const [language, setLanguage] = useState<SourceLanguage | "all">("all");
  const [fetchedRange, setFetchedRange] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [showUpload, setShowUpload] = useState(false);
  const [orderingCandidateId, setOrderingCandidateId] = useState<string | null>(
    null,
  );
  const runCandidateAction = action.run;
  const setCandidateSuccess = action.setSuccess;
  async function retryAnalysis(candidate: Candidate) {
    await action.run(async () => {
      await unwrap(
        await client.POST("/api/candidates/{id}/analysis-retry", {
          params: { path: { id: candidate.id } },
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ["candidates"] });
      action.setSuccess("识别已重新排队");
    });
  }
  async function classify(
    candidate: Candidate,
    label: components["schemas"]["CandidateVisualClass"],
  ) {
    await action.run(async () => {
      await unwrap(
        await client.PATCH("/api/candidates/{id}/classification", {
          params: { path: { id: candidate.id } },
          body: {
            label,
            expectedRevision: candidate.classificationRevision,
          },
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ["candidates"] });
      action.setSuccess("候选分类已更新");
    });
  }
  const batch = useCallback(
    async (kind: components["schemas"]["CandidateAction"]) => {
      const items = Object.entries(selected).map(([id, expectedRevision]) => ({
        id,
        expectedRevision,
      }));
      await runCandidateAction(async () => {
        const result = await unwrap(
          await client.POST("/api/candidates/actions", {
            body: { action: kind, items },
          }),
        );
        const failures = result.results.filter(
          (item) => !["succeeded", "unchanged"].includes(item.outcome),
        );
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["candidates"] }),
          invalidateWorkViews(),
        ]);
        setSelected({});
        setCandidateSuccess(
          failures.length
            ? `${result.results.length - failures.length} 项成功，${failures.length} 项需重新检查`
            : `${result.results.length} 项处理完成`,
        );
      });
    },
    [runCandidateAction, selected, setCandidateSuccess],
  );
  async function fetchSources() {
    await action.run(async () => {
      const run = await unwrap(
        await client.POST("/api/source-fetch/runs", { body: {} }),
      );
      setSourceRunId(run.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["candidates"] }),
        invalidateWorkViews(),
      ]);
      action.setSuccess("来源抓取已排队，后台完成后自动刷新候选");
    });
  }
  const selectedCount = Object.keys(selected).length;
  const topbarRegistration = useMemo(
    () =>
      selectedCount
        ? {
            content: (
              <div className="workspace-topbar-actions">
                <strong>已选择 {selectedCount} 项候选</strong>
                {status === "pending" ? (
                  <>
                    <Button
                      size="sm"
                      loading={action.busy}
                      onClick={() => void batch("import")}
                    >
                      入库
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={action.busy}
                      onClick={() => void batch("discard")}
                    >
                      忽略
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    loading={action.busy}
                    onClick={() => void batch("restore")}
                  >
                    恢复待处理
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected({})}
                >
                  清除选择
                </Button>
              </div>
            ),
            collapsedLabel: `已选 ${selectedCount}`,
          }
        : null,
    [action.busy, batch, selectedCount, status],
  );
  useTopbarActions(topbarRegistration);
  return (
    <PermissionGate permission="candidates:read">
      <SectionHeading title="候选池">
        筛选已抓取的图片组，批量入库为作品。
      </SectionHeading>
      {sourceRun.data && (
        <p className="account-notice" role="status">
          {sourceRun.data.status === "queued"
            ? "抓取已排队，等待后台处理"
            : sourceRun.data.status === "running"
              ? `正在抓取：已读取 ${sourceRun.data.items.reduce((sum, item) => sum + item.pagesFetched, 0)} 页`
              : `抓取结束：${sourceRun.data.status === "succeeded" ? "完成" : "部分通道未完成，请查看作者通道状态"}`}
        </p>
      )}
      <Toolbar>
        <SearchField
          placeholder="搜索作者昵称或 @账号"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setSelected({});
          }}
        />
        <SelectField
          aria-label="候选状态"
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setSelected({});
          }}
        >
          <option value="pending">待处理</option>
          <option value="imported">已入库</option>
          <option value="discarded">已忽略</option>
        </SelectField>
        <SelectField
          aria-label="来源语言"
          value={language}
          onValueChange={(value) => {
            setLanguage(value as SourceLanguage | "all");
            setSelected({});
          }}
        >
          <option value="all">全部语言</option>
          <option value="ja">日语</option>
          <option value="ko">韩语</option>
          <option value="en">英语</option>
        </SelectField>
        <SelectField
          aria-label="抓取时间"
          value={fetchedRange}
          onValueChange={(value) => {
            setFetchedRange(value);
            setSelected({});
          }}
        >
          <option value="all">全部时间</option>
          <option value="1">最近 24 小时</option>
          <option value="7">最近 7 天</option>
          <option value="30">最近 30 天</option>
        </SelectField>
        {user.permissions.includes("candidates:manage") && (
          <>
            <Button
              variant="secondary"
              leadingIcon={<Upload size={16} />}
              onClick={() => setShowUpload((value) => !value)}
            >
              手动上传
            </Button>
            <Button
              variant="secondary"
              leadingIcon={<RefreshCw size={16} />}
              title="同步全部已授权且已启用采集的作者账号"
              loading={action.busy}
              disabled={sourceActive}
              onClick={() => void fetchSources()}
            >
              同步图源
            </Button>
          </>
        )}
      </Toolbar>
      {showUpload && (
        <ManualCandidateUpload
          onClose={() => setShowUpload(false)}
          onUploaded={() =>
            Promise.all([
              queryClient.invalidateQueries({ queryKey: ["candidates"] }),
              invalidateWorkViews(),
            ])
          }
        />
      )}
      {user.permissions.includes("authors:admin") && <CandidateTagGroupPanel />}
      <Feedback error={action.error} success={action.success} />
      {status === "pending" ? (
        <div className="workspace-candidate-sections">
          {candidateTriageSections.map((section) => (
            <CandidateGridSection
              key={section.value}
              status="pending"
              group={section.value}
              language={language}
              fetchedRange={fetchedRange}
              search={search}
              selected={selected}
              onToggle={(candidate) =>
                setSelected((current) => {
                  const next = { ...current };
                  if (candidate.id in next) delete next[candidate.id];
                  else next[candidate.id] = candidate.revision;
                  return next;
                })
              }
              onSelectLoaded={(candidates) =>
                setSelected((current) => ({
                  ...current,
                  ...Object.fromEntries(
                    candidates.map((candidate) => [
                      candidate.id,
                      candidate.revision,
                    ]),
                  ),
                }))
              }
              onClassify={(candidate, label) => void classify(candidate, label)}
              onRetryAnalysis={(candidate) => void retryAnalysis(candidate)}
              orderingCandidateId={orderingCandidateId}
              onToggleOrdering={(id) =>
                setOrderingCandidateId((current) =>
                  current === id ? null : id,
                )
              }
            />
          ))}
        </div>
      ) : (
        <CandidateGridSection
          status={status as components["schemas"]["CandidateStatus"]}
          language={language}
          fetchedRange={fetchedRange}
          search={search}
          selected={selected}
          onToggle={(candidate) =>
            setSelected((current) => {
              const next = { ...current };
              if (candidate.id in next) delete next[candidate.id];
              else next[candidate.id] = candidate.revision;
              return next;
            })
          }
          onSelectLoaded={() => undefined}
          onClassify={(candidate, label) => void classify(candidate, label)}
          onRetryAnalysis={(candidate) => void retryAnalysis(candidate)}
          orderingCandidateId={orderingCandidateId}
          onToggleOrdering={(id) =>
            setOrderingCandidateId((current) => (current === id ? null : id))
          }
        />
      )}
    </PermissionGate>
  );
}

export function WorksPage() {
  const user = useAccount();
  const [params, setParams] = useSearchParams();
  const settings = useSettingsNavigation();
  const { view, tab, tabs } = workViewState(params, user);
  const qualificationKey = `${user.roles.join(",")}:${user.languageCapabilities.join(",")}:${user.permissions.join(",")}`;
  const isTodo = view === "work" && tab === "todo";
  const isClaim =
    view === "work" && ["translate", "proofread", "typeset"].includes(tab);
  const targetClaimStage = isClaim ? (tab as ClaimStage) : undefined;
  const [layout, setLayout] = useState<"grid" | "rows">("grid");
  const [language, setLanguage] = useState<SourceLanguage | "all">("all");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [search, setSearch] = useState("");
  const [mine, setMine] = useState(false);
  const deferredSearch = useDeferredValue(search.trim());
  const action = useAction();
  const runWorkAction = action.run;
  const setWorkSuccess = action.setSuccess;
  function changeView(nextView: "read" | "work", nextTab?: WorkTab) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("view", nextView);
      next.set("tab", nextTab ?? (nextView === "work" ? "todo" : "all"));
      next.delete("phase");
      next.delete("unassignedStage");
      return next;
    });
  }
  useEffect(() => {
    if (
      !settings.background &&
      params.get("tab") &&
      params.get("tab") !== tab
    ) {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set("tab", tab);
          return next;
        },
        { replace: true },
      );
    }
  }, [params, setParams, settings.background, tab]);
  const query = useInfiniteQuery({
    queryKey: [
      "works",
      user.id,
      qualificationKey,
      view,
      tab,
      language,
      view === "read" && mine,
      deferredSearch,
    ],
    gcTime: 0,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await client.GET("/api/works", {
          params: {
            query: {
              ...(isTodo
                ? { view: "todo" as const }
                : isClaim
                  ? {
                      view: "recommended" as const,
                      claimStage: targetClaimStage,
                    }
                  : view === "work" && tab === "pending_publish"
                    ? { view: "publish" as const }
                    : tab !== "all"
                      ? { phase: tab as WorkPhase }
                      : {}),
              ...(language === "all" ? {} : { sourceLanguage: language }),
              ...(view === "read" && mine ? { mine: true } : {}),
              ...(deferredSearch ? { search: deferredSearch } : {}),
              cursor: pageParam ?? undefined,
              limit: 24,
            },
          },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const summary = query.data?.pages[0];
  const canQuickClaim =
    Boolean(targetClaimStage) &&
    (language === "all"
      ? (["ja", "ko", "en"] as const).some((value) =>
          canHandleStage(user, targetClaimStage!, value),
        )
      : canHandleStage(user, targetClaimStage!, language));
  useEffect(() => {
    setSelected({});
    setSelectionMode(false);
  }, [view, tab, language, mine, search, deferredSearch, qualificationKey]);
  const claimSelected = useCallback(async () => {
    if (!targetClaimStage || !Object.keys(selected).length) return;
    await runWorkAction(async () => {
      try {
        const result = await unwrap(
          await client.POST("/api/works/stages/claims", {
            body: {
              stage: targetClaimStage,
              items: Object.entries(selected).map(([id, expectedRevision]) => ({
                id,
                expectedRevision,
                idempotencyKey: crypto.randomUUID(),
              })),
            },
          }),
        );
        const failures = result.results.filter(
          ({ outcome }) => outcome !== "succeeded",
        );
        setWorkSuccess(
          failures.length
            ? `${result.results.length - failures.length} 项认领成功，${failures.length} 项需重新检查`
            : `${result.results.length} 项${stageLabels[targetClaimStage]}职责已认领`,
        );
      } finally {
        setSelected({});
        setSelectionMode(false);
        await invalidateWorkViews();
      }
    });
  }, [runWorkAction, selected, setWorkSuccess, targetClaimStage]);
  const selectedCount = Object.keys(selected).length;
  const topbarRegistration = useMemo(
    () =>
      selectedCount && targetClaimStage
        ? {
            content: (
              <div className="workspace-topbar-actions">
                <strong>已选择 {selectedCount} 项</strong>
                <span>批量认领{stageLabels[targetClaimStage]}</span>
                <Button
                  size="sm"
                  leadingIcon={<Zap size={15} />}
                  loading={action.busy}
                  onClick={() => void claimSelected()}
                >
                  确认认领
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected({})}
                >
                  清除选择
                </Button>
              </div>
            ),
            collapsedLabel: `已选 ${selectedCount}`,
          }
        : null,
    [action.busy, claimSelected, selectedCount, targetClaimStage],
  );
  function tabCount(value: WorkTab) {
    if (view === "work")
      return value === "todo"
        ? (summary?.todoTotal ?? 0)
        : value === "pending_publish"
          ? (summary?.publishTotal ?? 0)
          : (summary?.claimCounts?.find((count) => count.stage === value)
              ?.count ?? 0);
    return value === "all"
      ? (summary?.phaseCounts.reduce(
          (total, entry) => total + entry.count,
          0,
        ) ?? 0)
      : (summary?.phaseCounts.find((entry) => entry.phase === value)?.count ??
          0);
  }
  function eligible(work: Work) {
    return Boolean(
      targetClaimStage &&
      work.personalTasks?.some((task) => task.stage === targetClaimStage) &&
      canHandleStage(user, targetClaimStage, work.sourceLanguage),
    );
  }
  const groups = isClaim
    ? [
        {
          key: "ready",
          title: "可立即开始",
          items: items.filter((work) =>
            work.personalTasks?.some(
              (task) => task.stage === targetClaimStage && task.readyToStart,
            ),
          ),
        },
        {
          key: "upstream",
          title: "提前认领 · 上游未完成",
          items: items.filter((work) =>
            work.personalTasks?.some(
              (task) => task.stage === targetClaimStage && !task.readyToStart,
            ),
          ),
        },
      ]
    : [{ key: "all", title: null, items }];
  return (
    <PermissionGate permission="works:read">
      <div className="account-content-boundary">
        <TypesetBatchTools
          enabled={isTodo}
          fallbackTopbar={topbarRegistration}
        />
        <SectionHeading title="作品">
          查看流程全貌，或按自己的职务和语言能力接取工作。
        </SectionHeading>
        <div
          className="workspace-view-toggle"
          role="group"
          aria-label="作品视角"
        >
          <Button
            size="sm"
            variant={view === "work" ? "primary" : "secondary"}
            aria-pressed={view === "work"}
            onClick={() => changeView("work")}
          >
            工作视图
          </Button>
          <Button
            size="sm"
            variant={view === "read" ? "primary" : "secondary"}
            aria-pressed={view === "read"}
            onClick={() => changeView("read")}
          >
            查看视图
          </Button>
        </div>
        <div
          className="workspace-tabs"
          role="tablist"
          aria-label={view === "work" ? "我的工作" : "作品阶段"}
        >
          {tabs.map((item) => (
            <button
              key={item.value}
              id={`work-tab-${view}-${item.value}`}
              type="button"
              role="tab"
              aria-controls="work-list-panel"
              tabIndex={tab === item.value ? 0 : -1}
              aria-selected={tab === item.value}
              className={tab === item.value ? "is-active" : ""}
              onClick={() => changeView(view, item.value)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const buttons = Array.from(
                  event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  ),
                );
                const index = buttons.indexOf(event.currentTarget);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (index +
                          (event.key === "ArrowRight" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[next].focus();
                buttons[next].click();
              }}
            >
              {item.label} <span>{tabCount(item.value)}</span>
            </button>
          ))}
        </div>
        <Toolbar>
          <SearchField
            placeholder="搜索作品或作者"
            aria-label="搜索作品或作者"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <SelectField
            aria-label="来源语言"
            value={language}
            onValueChange={(value) =>
              setLanguage(value as SourceLanguage | "all")
            }
          >
            <option value="all">全部语言</option>
            <option value="ja">日语</option>
            <option value="ko">韩语</option>
            <option value="en">英语</option>
          </SelectField>
          {view === "read" && (
            <label className="account-checkbox dashboard-mine-filter">
              <input
                type="checkbox"
                checked={mine}
                onChange={(event) => setMine(event.target.checked)}
              />
              只看我参与的
            </label>
          )}
          {isClaim && (
            <Button
              variant={selectionMode ? "primary" : "secondary"}
              leadingIcon={<Zap size={16} />}
              disabled={!canQuickClaim}
              onClick={() => {
                setSelectionMode((value) => !value);
                setSelected({});
              }}
            >
              {selectionMode ? "结束批量选择" : "批量认领"}
            </Button>
          )}
          {selectionMode && (
            <Button
              variant="ghost"
              disabled={!items.some(eligible)}
              onClick={() =>
                setSelected(
                  Object.fromEntries(
                    items
                      .filter(eligible)
                      .map((work) => [work.id, work.revision]),
                  ),
                )
              }
            >
              选择当前已加载
            </Button>
          )}
        </Toolbar>
        <Feedback error={action.error} success={action.success} />
        <div
          role="tabpanel"
          id="work-list-panel"
          aria-labelledby={`work-tab-${view}-${tab}`}
        >
          <PageState
            query={query}
            empty={(data) => (data.pages[0]?.total ?? 0) === 0}
            emptyContent={
              <EmptyState
                icon={<Inbox />}
                title={
                  isTodo
                    ? "这里空空如也，去接取新的任务吧"
                    : isClaim
                      ? "暂时没有匹配的可接取任务"
                      : "这里暂时没有作品"
                }
                description={
                  isTodo
                    ? "提前认领的任务会在上游提交后进入待办。"
                    : isClaim
                      ? "工作视图只展示匹配本人职务和语言能力的空缺。"
                      : "调整搜索或筛选条件后再试。"
                }
              />
            }
          >
            {() => (
              <>
                <p className="workspace-result-count">
                  共 {summary?.total ?? 0} 部作品
                  {view === "work" ? " · 各职责计数独立，不相加" : ""}
                </p>
                <div
                  className="workspace-view-toggle"
                  aria-label="作品展示方式"
                >
                  <Button
                    size="sm"
                    variant={layout === "grid" ? "primary" : "secondary"}
                    leadingIcon={<Grid2X2 size={15} />}
                    aria-pressed={layout === "grid"}
                    onClick={() => setLayout("grid")}
                  >
                    卡片展示
                  </Button>
                  <Button
                    size="sm"
                    variant={layout === "rows" ? "primary" : "secondary"}
                    leadingIcon={<List size={15} />}
                    aria-pressed={layout === "rows"}
                    onClick={() => setLayout("rows")}
                  >
                    按行展示
                  </Button>
                </div>
                {groups
                  .filter((group) => group.items.length)
                  .map((group) => (
                    <div
                      className="dashboard-recommendation-group"
                      key={group.key}
                    >
                      {group.title && <h3>{group.title}</h3>}
                      <div
                        className={`workspace-card-grid workspace-work-grid${layout === "rows" ? " workspace-work-grid--rows" : ""}`}
                      >
                        {group.items.map((work) => (
                          <WorkCard
                            key={work.id}
                            work={work}
                            actions={
                              isTodo ? (
                                <PersonalWorkActions work={work} view="todo" />
                              ) : isClaim ? (
                                <PersonalWorkActions
                                  work={work}
                                  view="recommended"
                                />
                              ) : undefined
                            }
                            selectionMode={selectionMode}
                            selected={work.id in selected}
                            selectionEligible={eligible(work)}
                            onToggleSelected={() =>
                              setSelected((current) => {
                                const next = { ...current };
                                if (work.id in next) delete next[work.id];
                                else next[work.id] = work.revision;
                                return next;
                              })
                            }
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                {query.hasNextPage && (
                  <div className="workspace-pagination">
                    <Button
                      variant="secondary"
                      loading={query.isFetchingNextPage}
                      onClick={() => void query.fetchNextPage()}
                    >
                      再加载 24 部作品
                    </Button>
                  </div>
                )}
              </>
            )}
          </PageState>
        </div>
      </div>
    </PermissionGate>
  );
}

function WorkCover({ work }: { work: Work }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const query = useImageUrl(
    ["thumbnail", "work-cover", work.id, work.coverImageId],
    async () =>
      unwrap(
        await client.GET("/api/works/{workId}/images/{imageId}/url", {
          params: {
            path: { workId: work.id, imageId: work.coverImageId! },
            query: { variant: "thumbnail" },
          },
        }),
      ),
    Boolean(work.coverImageId),
  );
  const detail = useApiQuery(
    ["work-lightbox", work.id],
    async () =>
      unwrap(
        await client.GET("/api/works/{id}", {
          params: { path: { id: work.id } },
        }),
      ),
    lightboxIndex !== null,
  );
  const lightboxImage =
    lightboxIndex === null ? undefined : detail.data?.images[lightboxIndex];
  const lightboxQuery = useImageUrl(
    ["work-image", work.id, lightboxImage?.id],
    async () =>
      unwrap(
        await client.GET("/api/works/{workId}/images/{imageId}/url", {
          params: {
            path: { workId: work.id, imageId: lightboxImage!.id },
          },
        }),
      ),
    Boolean(lightboxImage),
  );
  const safe = isDisplayableImageUrl(query.data?.url);
  return (
    <>
      <button
        type="button"
        className="workspace-work-cover workspace-cover-button"
        aria-label={`查看 ${workDisplayTitle(work)} 的大图`}
        onClick={() => setLightboxIndex(0)}
      >
        {safe ? (
          <img src={query.data!.url!} alt="" loading="lazy" />
        ) : (
          <ImageIcon aria-hidden="true" />
        )}
        <span>{work.imageCount} 页</span>
      </button>
      {lightboxIndex !== null && (
        <ImageLightbox
          src={
            isDisplayableImageUrl(lightboxQuery.data?.url)
              ? lightboxQuery.data!.url
              : undefined
          }
          alt={`${workDisplayTitle(work)} 第 ${lightboxIndex + 1} 页`}
          index={lightboxIndex}
          count={detail.data?.images.length ?? work.imageCount}
          thumbnailSrc={
            lightboxIndex === 0 && isDisplayableImageUrl(query.data?.url)
              ? query.data!.url
              : undefined
          }
          loading={detail.isPending || lightboxQuery.isPending}
          onClose={() => setLightboxIndex(null)}
          onPrevious={
            lightboxIndex > 0
              ? () => setLightboxIndex((value) => (value ?? 1) - 1)
              : undefined
          }
          onNext={
            lightboxIndex < (detail.data?.images.length ?? work.imageCount) - 1
              ? () => setLightboxIndex((value) => (value ?? -1) + 1)
              : undefined
          }
        />
      )}
    </>
  );
}

function WorkCard({
  work,
  selectionMode = false,
  selected = false,
  selectionEligible = true,
  onToggleSelected,
  actions,
}: {
  work: Work;
  selectionMode?: boolean;
  selected?: boolean;
  selectionEligible?: boolean;
  onToggleSelected?: () => void;
  actions?: ReactNode;
}) {
  return (
    <Surface className={`workspace-work-card${selected ? " is-selected" : ""}`}>
      <WorkCover work={work} />
      <div className="workspace-card-body">
        <div className="workspace-card-title">
          <div>
            <span>
              #{work.workNumber} · {work.authorName}
            </span>
            <h2>
              <Link to={`/works/${work.id}`}>{workDisplayTitle(work)}</Link>
            </h2>
          </div>
          {selectionMode && (
            <label className="account-checkbox workspace-work-select">
              <input
                type="checkbox"
                checked={selected}
                disabled={!selectionEligible}
                onChange={onToggleSelected}
              />
              选择
            </label>
          )}
        </div>
        <div className="workspace-tags">
          <WorkflowBadge value={work.workflowStatus} />
          <ReviewBadge value={work.reviewStatus} />
          <Badge>{sourceLanguageLabels[work.sourceLanguage]}</Badge>
          {work.collaborationMode === "multi" && (
            <Badge tone="info">多人</Badge>
          )}
          <TranslationAttentionBadge work={work} />
        </div>
        <footer>
          <span>{work.participantCount} 人参与</span>
          <time>{dateTime(work.updatedAt)}</time>
        </footer>
        {actions}
      </div>
    </Surface>
  );
}

function currentStage(status: WorkflowStatus): WorkStage | null {
  if (status === "pending_translate" || status === "translating") {
    return "translate";
  }
  if (status === "pending_proofread" || status === "proofreading") {
    return "proofread";
  }
  if (status === "pending_typeset" || status === "typesetting") {
    return "typeset";
  }
  if (status === "pending_publish") return "publish";
  return null;
}
function PageAssignmentEditor({
  work,
  participant,
  onUpdated,
}: {
  work: WorkDetail;
  participant: WorkDetail["participants"][number];
  onUpdated: (work: WorkDetail) => void;
}) {
  const action = useAction();
  const [selected, setSelected] = useState(participant.assignedImageIds);
  useEffect(() => setSelected(participant.assignedImageIds), [participant]);
  async function save() {
    await action.run(async () => {
      const updated = await unwrap(
        await client.POST("/api/works/{id}/stages/assignments", {
          params: { path: { id: work.id } },
          body: {
            expectedRevision: work.revision,
            idempotencyKey: crypto.randomUUID(),
            stage: participant.stage as CoordinatedStage,
            participantId: participant.id,
            imageIds: selected,
          },
        }),
      );
      onUpdated(updated);
      action.setSuccess("页码分工已保存");
    });
  }
  return (
    <details className="workspace-page-assignment">
      <summary>
        分工页码 · {participant.assignedImageIds.length || "未设置"} 页
      </summary>
      <div className="workspace-page-assignment__pages">
        {work.images.map((image, index) => (
          <label key={image.id}>
            <input
              type="checkbox"
              checked={selected.includes(image.id)}
              onChange={() =>
                setSelected((current) =>
                  current.includes(image.id)
                    ? current.filter((id) => id !== image.id)
                    : [...current, image.id],
                )
              }
            />
            {index + 1}
          </label>
        ))}
      </div>
      <Feedback error={action.error} success={action.success} />
      <Button
        size="sm"
        variant="secondary"
        loading={action.busy}
        onClick={() => void save()}
      >
        保存分工
      </Button>
    </details>
  );
}

function orderTypesetFiles(files: File[]) {
  const numbered = files.map((file, index) => {
    const match = file.name.replace(/\.[^.]+$/, "").match(/-(\d+)$/);
    return { file, index, number: match ? Number(match[1]) : null };
  });
  if (
    files.length > 1 &&
    numbered.every((item) => item.number !== null) &&
    new Set(numbered.map((item) => item.number)).size === files.length
  ) {
    return numbered
      .sort(
        (left, right) =>
          left.number! - right.number! ||
          left.file.name.localeCompare(right.file.name) ||
          left.index - right.index,
      )
      .map((item) => item.file);
  }
  return files;
}

function typesetFileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function TypesetVersionImage({
  workId,
  versionId,
  image,
  onPreview,
}: {
  workId: string;
  versionId: string;
  image: TypesetVersion["images"][number];
  onPreview: () => void;
}) {
  const query = useImageUrl(
    ["thumbnail", "typeset-version-image", workId, versionId, image.id],
    async () =>
      unwrap(
        await client.GET(
          "/api/works/{workId}/typeset/versions/{versionId}/images/{imageId}/url",
          {
            params: {
              path: { workId, versionId, imageId: image.id },
              query: { variant: "thumbnail" },
            },
          },
        ),
      ),
  );
  const safe = isDisplayableImageUrl(query.data?.url);
  return (
    <button
      type="button"
      className="workspace-typeset-image"
      aria-label={`预览成图第 ${image.orderIndex + 1} 页`}
      onClick={onPreview}
    >
      {safe ? (
        <img src={query.data!.url!} alt={`成图第 ${image.orderIndex + 1} 页`} />
      ) : (
        <ImageIcon />
      )}
      <span>{image.orderIndex + 1}</span>
    </button>
  );
}

function ReviewStageNotice({
  work,
  message,
}: {
  work: WorkDetail;
  message: string;
}) {
  if (work.reviewStatus === "normal" || !work.openReviewCaseId) return null;
  return (
    <div className="workspace-stage-review-notice" role="status">
      <div>
        <Badge tone={work.reviewStatus === "blocked" ? "danger" : "warning"}>
          {reviewLabels[work.reviewStatus]}
        </Badge>
        <p>{message}</p>
      </div>
      <Link className="account-link" to={`/reviews/${work.openReviewCaseId}`}>
        <FileCheck2 size={16} />
        查看并处理审核
      </Link>
    </div>
  );
}

function TypesetVersionPanel({
  work,
  canManage,
  canUpload,
  canCancelSubmission = false,
  reviewSnapshotVersionId,
  onUpdated,
  onWorkUpdated,
}: {
  work: WorkDetail;
  canManage: boolean;
  canUpload: boolean;
  canCancelSubmission?: boolean;
  reviewSnapshotVersionId?: string | null;
  onUpdated: () => Promise<unknown>;
  onWorkUpdated: (work: WorkDetail) => Promise<unknown>;
}) {
  const action = useAction();
  const [files, setFiles] = useState<File[]>([]);
  const [sourceImageIds, setSourceImageIds] = useState<Record<string, string>>(
    {},
  );
  const [mode, setMode] = useState<"new_version" | "replace_current">(
    "new_version",
  );
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<{
    versionId: string;
    imageIndex: number;
  } | null>(null);
  const query = useApiQuery(["typeset-versions", work.id], async () =>
    unwrap(
      await client.GET("/api/works/{workId}/typeset/versions", {
        params: { path: { workId: work.id } },
      }),
    ),
  );
  const versions = query.data;
  const previewVersion = versions?.items.find(
    (version) => version.id === preview?.versionId,
  );
  const previewImage =
    preview === null ? undefined : previewVersion?.images[preview.imageIndex];
  const previewQuery = useImageUrl(
    ["typeset-version-image", work.id, preview?.versionId, previewImage?.id],
    async () =>
      unwrap(
        await client.GET(
          "/api/works/{workId}/typeset/versions/{versionId}/images/{imageId}/url",
          {
            params: {
              path: {
                workId: work.id,
                versionId: preview!.versionId,
                imageId: previewImage!.id,
              },
            },
          },
        ),
      ),
    Boolean(previewImage),
  );

  async function finish(result: TypesetVersionList, message: string) {
    queryClient.setQueryData(["typeset-versions", work.id], result);
    await onUpdated();
    action.setSuccess(message);
  }

  function moveFile(index: number, offset: number) {
    setFiles((current) => {
      const nextIndex = index + offset;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  async function uploadVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!files.length || !versions) return;
    if (
      mode === "replace_current" &&
      !window.confirm(
        "替换会创建新的不可变版本，并把当前版本放入 30 天回收期。确定继续吗？",
      )
    ) {
      return;
    }
    const formElement = event.currentTarget;
    await action.run(async () => {
      await uploadDirect(
        {
          purpose: "typeset_single",
          resourceId: work.id,
          expectedRevision: versions.workRevision,
          mode,
          ...(note.trim() ? { note: note.trim() } : {}),
          sourceImageIds: JSON.stringify(
            files.map((file) => sourceImageIds[typesetFileKey(file)] || null),
          ),
        },
        files,
      );
      const result = await unwrap(
        await client.GET("/api/works/{workId}/typeset/versions", {
          params: { path: { workId: work.id } },
        }),
      );
      setFiles([]);
      setSourceImageIds({});
      setNote("");
      formElement.reset();
      await finish(result, `已上传成图版本 v${result.items[0].versionNumber}`);
    });
  }

  async function selectVersion(version: TypesetVersion) {
    if (!versions || version.isCurrent) return;
    await action.run(async () => {
      const result = await unwrap(
        await client.POST(
          "/api/works/{workId}/typeset/versions/{versionId}/select",
          {
            params: {
              path: { workId: work.id, versionId: version.id },
            },
            body: {
              expectedRevision: versions.workRevision,
              idempotencyKey: crypto.randomUUID(),
            },
          },
        ),
      );
      await finish(result, `已切换到成图版本 v${version.versionNumber}`);
    });
  }

  async function deleteVersion(version: TypesetVersion) {
    if (!versions) return;
    const message = version.isCurrent
      ? "这是当前成图版本。删除后作品将暂时没有当前成图，确定继续吗？"
      : `删除成图版本 v${version.versionNumber}？30 天内仍可恢复。`;
    if (!window.confirm(message)) return;
    await action.run(async () => {
      const result = await unwrap(
        await client.POST(
          "/api/works/{workId}/typeset/versions/{versionId}/delete",
          {
            params: {
              path: { workId: work.id, versionId: version.id },
            },
            body: {
              expectedRevision: versions.workRevision,
              idempotencyKey: crypto.randomUUID(),
              clearCurrent: version.isCurrent,
            },
          },
        ),
      );
      await finish(result, `成图版本 v${version.versionNumber} 已进入回收期`);
    });
  }

  async function restoreVersion(version: TypesetVersion) {
    if (!versions) return;
    await action.run(async () => {
      const result = await unwrap(
        await client.POST(
          "/api/works/{workId}/typeset/versions/{versionId}/restore",
          {
            params: {
              path: { workId: work.id, versionId: version.id },
            },
            body: {
              expectedRevision: versions.workRevision,
              idempotencyKey: crypto.randomUUID(),
            },
          },
        ),
      );
      await finish(
        result,
        `成图版本 v${version.versionNumber} 已恢复到可选版本列表`,
      );
    });
  }

  async function submitTypeset() {
    if (!versions?.currentVersionId) return;
    if (
      !window.confirm(
        "确认当前成图版本已经完整，可以交给运营发布吗？提交后将冻结本轮嵌字署名。",
      )
    ) {
      return;
    }
    await action.run(async () => {
      const updated = await unwrap(
        await client.POST("/api/works/{id}/stages/submit", {
          params: { path: { id: work.id } },
          body: {
            stage: "typeset",
            expectedRevision: versions.workRevision,
            expectedEditorEpoch: work.editorEpoch,
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      );
      await onWorkUpdated(updated);
      action.setSuccess("嵌字阶段已完成，作品已进入待发布");
    });
  }

  async function cancelTypesetSubmission() {
    if (
      !window.confirm(
        "确定取消嵌字提交吗？作品将回到嵌字中，原负责人恢复编辑资格，当前成图和历史提交记录都会保留。",
      )
    ) {
      return;
    }
    await action.run(async () => {
      const updated = await unwrap(
        await client.POST("/api/works/{id}/stages/submission/cancel", {
          params: { path: { id: work.id } },
          body: {
            stage: "typeset",
            expectedRevision: work.revision,
            expectedEditorEpoch: work.editorEpoch,
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      );
      await onWorkUpdated(updated);
      await query.refetch();
      action.setSuccess("已取消嵌字提交，可以继续整理成图版本");
    });
  }

  return (
    <Surface className="workspace-panel workspace-typeset-versions">
      <div className="workspace-panel-heading">
        <div>
          <h2>成图版本</h2>
          <p>每次上传形成不可变版本；覆盖当前版本也会保留 30 天恢复期。</p>
        </div>
        {versions?.currentVersionId && (
          <Badge tone="success">已有当前成图</Badge>
        )}
      </div>
      {work.workflowStatus === "pending_publish" && (
        <p className="workspace-muted">
          当前成图已提交并冻结。需要调整时，由本轮嵌字提交人先取消提交；审核处理中请等待审核决定。
        </p>
      )}
      {canCancelSubmission &&
        work.workflowStatus === "pending_publish" &&
        work.reviewStatus === "normal" && (
          <Button
            variant="secondary"
            loading={action.busy}
            onClick={() => void cancelTypesetSubmission()}
          >
            取消嵌字提交
          </Button>
        )}
      <ReviewStageNotice
        work={work}
        message="可以继续上传和整理修正版供复核；审核解决前不能确认嵌字完成。"
      />
      {canUpload && (
        <form
          className="workspace-typeset-upload"
          onSubmit={(event) => void uploadVersion(event)}
        >
          <label className="workspace-file-field">
            <span>成图图片</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              required
              onChange={(event) => {
                setFiles(
                  orderTypesetFiles(
                    Array.from(event.currentTarget.files ?? []),
                  ),
                );
                setSourceImageIds({});
              }}
            />
            <small>
              可上传与原图数量或尺寸不同的结果，也可加入说明图；至少 1 张、最多
              100 张，每张不超过 25 MiB，版本合计不超过 250 MiB。
            </small>
          </label>
          <SelectField
            label="上传方式"
            value={mode}
            onValueChange={(value) => setMode(value as typeof mode)}
          >
            <option value="new_version">新增版本</option>
            <option
              value="replace_current"
              disabled={!versions?.currentVersionId}
            >
              替换当前版本并保留旧版
            </option>
          </SelectField>
          <TextField
            label="版本说明（可选）"
            value={note}
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
          />
          {files.length > 0 && (
            <div className="workspace-typeset-file-order">
              <strong>页序预览 · {files.length} 页</strong>
              <p>
                末尾带完整 -1/-01
                编号时已自动排序；其余文件按当前顺序提交，可手动调整。
              </p>
              <ol>
                {files.map((file, index) => (
                  <li key={`${file.name}-${file.lastModified}-${index}`}>
                    <span>
                      {index + 1}. {file.name}
                    </span>
                    <SelectField
                      label="来源原图（可选）"
                      value={sourceImageIds[typesetFileKey(file)] ?? ""}
                      onValueChange={(value) =>
                        setSourceImageIds((current) => ({
                          ...current,
                          [typesetFileKey(file)]: value,
                        }))
                      }
                    >
                      <option value="">不关联</option>
                      {work.images.map((image, sourceIndex) => (
                        <option
                          key={image.id}
                          value={image.id}
                          disabled={Object.entries(sourceImageIds).some(
                            ([key, value]) =>
                              key !== typesetFileKey(file) &&
                              value === image.id,
                          )}
                        >
                          原图第 {sourceIndex + 1} 页
                        </option>
                      ))}
                    </SelectField>
                    <div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`上移 ${file.name}`}
                        disabled={index === 0}
                        onClick={() => moveFile(index, -1)}
                      >
                        <ArrowUp size={15} />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`下移 ${file.name}`}
                        disabled={index === files.length - 1}
                        onClick={() => moveFile(index, 1)}
                      >
                        <ArrowDown size={15} />
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <Button
            type="submit"
            loading={action.busy}
            disabled={!versions || files.length < 1 || files.length > 100}
            leadingIcon={<Upload size={16} />}
          >
            上传成图版本
          </Button>
        </form>
      )}
      {!canUpload && work.workflowStatus === "typesetting" && (
        <p className="workspace-muted">
          {work.typesetHandoffStartedAt
            ? "当前账号可查看版本；加入本作品嵌字阶段后才能上传。"
            : "请先由嵌字成员取得统一交接包，再上传成图。"}
        </p>
      )}
      <Feedback error={action.error} success={action.success} />
      {query.isPending ? (
        <p className="workspace-muted">正在读取成图版本…</p>
      ) : query.isError ? (
        <p className="account-error">{query.error.message}</p>
      ) : Array.isArray(versions?.items) && versions.items.length ? (
        <div className="workspace-typeset-version-list">
          {versions.items.map((version) => (
            <article
              className={version.deletedAt ? "is-deleted" : ""}
              key={version.id}
            >
              <header>
                <div>
                  <h3>版本 v{version.versionNumber}</h3>
                  <p>
                    {version.uploadedByName} · {dateTime(version.createdAt)}
                  </p>
                </div>
                <div className="workspace-version-badges">
                  {version.isCurrent && <Badge tone="success">当前版本</Badge>}
                  {version.needsTextReview && (
                    <Badge tone="warning">旧文本 · 待复核</Badge>
                  )}
                  {version.id === reviewSnapshotVersionId && (
                    <Badge tone="warning">审核发起时版本</Badge>
                  )}
                  {version.deletedAt && <Badge tone="warning">回收期</Badge>}
                </div>
              </header>
              {version.note && <p>{version.note}</p>}
              <div className="workspace-typeset-image-grid">
                {version.images.map((image) => (
                  <TypesetVersionImage
                    workId={work.id}
                    versionId={version.id}
                    image={image}
                    key={image.id}
                    onPreview={() =>
                      setPreview({
                        versionId: version.id,
                        imageIndex: version.images.findIndex(
                          (item) => item.id === image.id,
                        ),
                      })
                    }
                  />
                ))}
              </div>
              <footer>
                <small>
                  {version.deletedAt
                    ? version.purgeAfter &&
                      new Date(version.purgeAfter).getTime() > Date.now()
                      ? `可恢复至 ${dateTime(version.purgeAfter)}`
                      : "恢复期已结束，等待生命周期任务清理"
                    : `${version.images.length} 页${version.automaticallySorted ? " · 已按编号自动排序" : " · 使用确认后的页序"}`}
                </small>
                {canManage && work.workflowStatus === "typesetting" && (
                  <div className="workspace-inline-actions">
                    {version.deletedAt ? (
                      version.purgeAfter &&
                      new Date(version.purgeAfter).getTime() > Date.now() ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={action.busy}
                          onClick={() => void restoreVersion(version)}
                        >
                          恢复到版本列表
                        </Button>
                      ) : null
                    ) : (
                      <>
                        {!version.isCurrent && !version.needsTextReview && (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={action.busy}
                            onClick={() => void selectVersion(version)}
                          >
                            设为当前
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={action.busy}
                          onClick={() => void deleteVersion(version)}
                        >
                          删除
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Images />}
          title="还没有成图版本"
          description="下载交接材料并完成嵌字后，在这里上传全部页面。"
        />
      )}
      {canUpload &&
        versions?.currentVersionId &&
        work.reviewStatus === "normal" && (
          <div className="workspace-typeset-submit">
            <div>
              <strong>
                {versions.items.find((v) => v.isCurrent)?.needsTextReview
                  ? "当前成图仍需对照新文本复核"
                  : "当前版本已经可用于交付"}
              </strong>
              <p>确认完成后进入待发布，并冻结本轮嵌字署名。</p>
            </div>
            <Button
              loading={action.busy}
              disabled={Boolean(
                versions.items.find((v) => v.isCurrent)?.needsTextReview,
              )}
              onClick={() => void submitTypeset()}
            >
              <CheckCircle2 size={16} />
              确认嵌字完成
            </Button>
          </div>
        )}
      {preview && previewVersion && (
        <ImageLightbox
          src={
            isDisplayableImageUrl(previewQuery.data?.url) &&
            !previewQuery.isFetching
              ? previewQuery.data.url
              : undefined
          }
          alt={`成图版本 v${previewVersion.versionNumber} 第 ${preview.imageIndex + 1} 页`}
          index={preview.imageIndex}
          count={previewVersion.images.length}
          loading={previewQuery.isPending || previewQuery.isFetching}
          onClose={() => setPreview(null)}
          onPrevious={
            preview.imageIndex > 0
              ? () =>
                  setPreview((current) =>
                    current
                      ? { ...current, imageIndex: current.imageIndex - 1 }
                      : null,
                  )
              : undefined
          }
          onNext={
            preview.imageIndex < previewVersion.images.length - 1
              ? () =>
                  setPreview((current) =>
                    current
                      ? { ...current, imageIndex: current.imageIndex + 1 }
                      : null,
                  )
              : undefined
          }
        />
      )}
    </Surface>
  );
}

function PublishingPanel({
  work,
  canConfirm,
  onUpdated,
}: {
  work: WorkDetail;
  canConfirm: boolean;
  onUpdated: (view: PublishingView) => Promise<unknown>;
}) {
  const user = useAccount();
  const action = useAction();
  const [note, setNote] = useState("");
  const query = useApiQuery(["publishing", work.id, work.revision], async () =>
    unwrap(
      await client.GET("/api/works/{workId}/publishing", {
        params: { path: { workId: work.id } },
      }),
    ),
  );

  async function copyText(text: string) {
    await action.run(async () => {
      if (!navigator.clipboard?.writeText) {
        throw new Error("当前浏览器不支持剪贴板写入，请手动选择文案复制");
      }
      await navigator.clipboard.writeText(text);
      action.setSuccess("发布文案已复制");
    });
  }

  async function downloadImages() {
    await action.run(async () => {
      await downloadPrepared({
        purpose: "publication",
        workId: work.id,
        expectedRevision: work.revision,
        expectedEditorEpoch: work.editorEpoch,
        idempotencyKey: crypto.randomUUID(),
      });
      action.setSuccess("当前成图包已下载");
    });
  }

  async function confirmPublication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.data) return;
    if (
      !window.confirm(
        `确认已使用成图版本 v${query.data.currentTypesetVersionNumber} 完成发布吗？文案和版本将保存为不可变历史。`,
      )
    ) {
      return;
    }
    await action.run(async () => {
      const result = await unwrap(
        await client.POST("/api/works/{workId}/publishing/confirm", {
          params: { path: { workId: work.id } },
          body: {
            expectedRevision: query.data!.workRevision,
            idempotencyKey: crypto.randomUUID(),
            note: note.trim() || null,
          },
        }),
      );
      queryClient.setQueryData(
        ["publishing", work.id, result.workRevision],
        result,
      );
      setNote("");
      await onUpdated(result);
      action.setSuccess("发布已确认并保存历史快照");
    });
  }

  async function savePublicationBody(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.data) return;
    const body = String(
      new FormData(event.currentTarget).get("publicationBody") ?? "",
    ).trim();
    await action.run(async () => {
      const updated = await unwrap(
        await client.PATCH("/api/works/{id}", {
          params: { path: { id: work.id } },
          body: {
            publicationBody: body || null,
            expectedRevision: query.data!.workRevision,
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      );
      queryClient.setQueryData(["work", work.id], updated);
      await onUpdated(query.data!);
      action.setSuccess(body ? "作品正文已保存" : "作品正文已清空");
    });
  }

  return (
    <Surface className="workspace-panel workspace-publishing">
      <div className="workspace-panel-heading">
        <div>
          <h2>发布整理</h2>
          <p>文案由服务端模板生成；原帖链接单独提供，不写入默认文案。</p>
        </div>
        {query.data && (
          <Badge
            tone={
              query.data.workflowStatus === "published" ? "success" : "warning"
            }
          >
            {workflowLabels[query.data.workflowStatus]}
          </Badge>
        )}
      </div>
      <ReviewStageNotice
        work={work}
        message="发布文案和成图仍可查看、复制及下载；审核解决前不能确认发布。"
      />
      {query.isPending ? (
        <p className="workspace-muted">正在整理发布内容…</p>
      ) : query.isError ? (
        <p className="account-error">{query.error.message}</p>
      ) : query.data ? (
        <>
          <div className="workspace-publish-summary">
            <span>当前成图 v{query.data.currentTypesetVersionNumber}</span>
            <span>{query.data.imageCount} 页</span>
            <span>
              {query.data.templateName} r{query.data.templateRevision}
            </span>
            {query.data.sourcePostUrl && (
              <a
                href={query.data.sourcePostUrl}
                target="_blank"
                rel="noreferrer"
              >
                打开原帖 <ExternalLink size={14} />
              </a>
            )}
          </div>
          <pre className="workspace-publish-copy">
            {query.data.generatedText}
          </pre>
          {work.reviewStatus === "normal" &&
            work.workflowStatus === "pending_publish" &&
            user.permissions.includes("works:metadata") && (
              <OptionalSection
                label="作品正文（可选）"
                hasContent={Boolean(query.data.body)}
              >
                <form
                  className="workspace-stacked-form"
                  key={query.data.body ?? ""}
                  onSubmit={(event) => void savePublicationBody(event)}
                >
                  <label className="ui-field">
                    <span className="ui-field__label">作品正文</span>
                    <div className="ui-field__control">
                      <textarea
                        name="publicationBody"
                        defaultValue={query.data.body ?? ""}
                        maxLength={10000}
                        placeholder="选填；原帖配文不会自动加入发布文案"
                      />
                    </div>
                  </label>
                  <Button type="submit" size="sm" loading={action.busy}>
                    保存作品正文
                  </Button>
                </form>
              </OptionalSection>
            )}
          <div className="workspace-inline-actions">
            <Button
              variant="secondary"
              loading={action.busy}
              onClick={() => void copyText(query.data!.generatedText)}
            >
              <FileText size={16} />
              复制文案
            </Button>
            <Button
              variant="secondary"
              loading={action.busy}
              onClick={() => void downloadImages()}
            >
              <Download size={16} />
              下载当前成图
            </Button>
          </div>
          {canConfirm &&
            query.data.workflowStatus === "pending_publish" &&
            work.reviewStatus === "normal" && (
              <form
                className="workspace-publish-confirm"
                onSubmit={(event) => void confirmPublication(event)}
              >
                <TextField
                  label="发布备注（可选）"
                  value={note}
                  maxLength={1000}
                  onChange={(event) => setNote(event.target.value)}
                />
                <Button type="submit" loading={action.busy}>
                  确认已经发布
                </Button>
              </form>
            )}
          <Feedback error={action.error} success={action.success} />
          {query.data.records.length > 0 && (
            <div className="workspace-publish-history">
              <h3>发布历史</h3>
              {query.data.records.map((record) => (
                <details key={record.id}>
                  <summary>
                    v{record.typesetVersionNumber} · {record.publishedByName} ·{" "}
                    {dateTime(record.publishedAt)}
                  </summary>
                  {record.note && <p>{record.note}</p>}
                  <pre>{record.generatedText}</pre>
                </details>
              ))}
            </div>
          )}
        </>
      ) : null}
    </Surface>
  );
}
export function WorkDetailPage() {
  const { id = "" } = useParams();
  const user = useAccount();
  const action = useAction();
  const [reason, setReason] = useState("");
  const [temporaryCredits, setTemporaryCredits] = useState<
    Record<string, string>
  >({});
  const query = useApiQuery(["work", id], async () =>
    unwrap(await client.GET("/api/works/{id}", { params: { path: { id } } })),
  );
  function discardEditorCache() {
    queryClient.removeQueries({
      queryKey: ["translation-editor", id],
      exact: true,
    });
  }
  async function stageAction(work: WorkDetail, stage: CoordinatedStage) {
    await action.run(async () => {
      const body = {
        expectedRevision: work.revision,
        idempotencyKey: crypto.randomUUID(),
        stage,
      };
      const updated = await unwrap(
        await client.POST("/api/works/{id}/stages/join", {
          params: { path: { id } },
          body,
        }),
      );
      queryClient.setQueryData(["work", id], updated);
      discardEditorCache();
      await invalidateWorkViews();
      action.setSuccess(`已加入${stageLabels[stage]}`);
    });
  }
  async function claimStage(work: WorkDetail, stage: CoordinatedStage) {
    await action.run(async () => {
      const updated = await unwrap(
        await client.POST("/api/works/{id}/stages/claim", {
          params: { path: { id } },
          body: {
            expectedRevision: work.revision,
            idempotencyKey: crypto.randomUUID(),
            stage,
          },
        }),
      );
      queryClient.setQueryData(["work", id], updated);
      discardEditorCache();
      await invalidateWorkViews();
      action.setSuccess(`已认领${stageLabels[stage]}职责`);
    });
  }
  async function updateStageCredit(
    work: WorkDetail,
    participant: WorkDetail["participants"][number],
    stage: CoordinatedStage,
  ) {
    await action.run(async () => {
      const creditName = (
        temporaryCredits[participant.id] ??
        participant.workCreditName ??
        ""
      ).trim();
      const updated = await unwrap(
        await client.PATCH("/api/works/{id}/stages/credit", {
          params: { path: { id } },
          body: {
            expectedRevision: work.revision,
            idempotencyKey: crypto.randomUUID(),
            stage,
            creditName: creditName || null,
          },
        }),
      );
      queryClient.setQueryData(["work", id], updated);
      await invalidateWorkViews();
      action.setSuccess(
        creditName
          ? `${stageLabels[stage]}临时署名已保存`
          : `${stageLabels[stage]}已恢复使用成员昵称署名`,
      );
    });
  }
  async function updateMetadata(
    event: FormEvent<HTMLFormElement>,
    work: WorkDetail,
  ) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const title = String(data.get("title") ?? "").trim();
    await action.run(async () => {
      if (!title) throw new Error("请填写作品标题后保存");
      const updated = await unwrap(
        await client.PATCH("/api/works/{id}", {
          params: { path: { id: work.id } },
          body: {
            title,
            expectedRevision: work.revision,
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      );
      queryClient.setQueryData(["work", id], updated);
      await invalidateWorkViews();
      action.setSuccess("作品信息已保存");
    });
  }
  async function leaveStage(work: WorkDetail, stage: CoordinatedStage) {
    const activeCount = work.participants.filter(
      (participant) =>
        participant.stage === stage &&
        !participant.submittedAt &&
        !participant.leftAt,
    ).length;
    const warning =
      activeCount === 1 && stage === "translate"
        ? "你是最后一名翻译。取消后会删除本轮全部未提交译文并使旧设备草稿失效，是否继续？"
        : activeCount === 1 && stage === "proofread"
          ? "你是最后一名校对。取消后会恢复最近的正式翻译版本并使本轮校对草稿失效，是否继续？"
          : "确定取消本次接取吗？已保存的共享内容会保留，未完成页需要重新分配。";
    if (!window.confirm(warning)) return;
    await action.run(async () => {
      const updated = await unwrap(
        await client.POST("/api/works/{id}/stages/leave", {
          params: { path: { id } },
          body: {
            expectedRevision: work.revision,
            idempotencyKey: crypto.randomUUID(),
            stage,
          },
        }),
      );
      queryClient.setQueryData(["work", id], updated);
      discardEditorCache();
      await deleteTranslationDraft(user.id, id).catch(() => undefined);
      await invalidateWorkViews();
      action.setSuccess(`已取消${stageLabels[stage]}职责`);
    });
  }
  async function updateCollaboration(work: WorkDetail) {
    const next = work.collaborationMode === "single" ? "multi" : "single";
    if (
      !window.confirm(
        next === "multi"
          ? "开启多人协作后，同一阶段可加入多人，并启用页码分工与个人完成确认。"
          : "切回单人模式要求每个阶段至多一名参与者，且不能保留同一用户翻译并校对的记录。是否继续？",
      )
    ) {
      return;
    }
    await action.run(async () => {
      const updated = await unwrap(
        await client.PATCH("/api/works/{id}/collaboration", {
          params: { path: { id } },
          body: {
            collaborationMode: next,
            expectedRevision: work.revision,
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      );
      queryClient.setQueryData(["work", id], updated);
      discardEditorCache();
      await invalidateWorkViews();
      action.setSuccess(next === "multi" ? "已开启多人协作" : "已切回单人模式");
    });
  }
  async function openReview(work: WorkDetail, event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      await unwrap(
        await client.POST("/api/works/{workId}/reviews", {
          params: { path: { workId: id } },
          body: {
            expectedRevision: work.revision,
            idempotencyKey: crypto.randomUUID(),
            reason,
            expectedEditorEpoch: work.editorEpoch,
          },
        }),
      );
      await refreshReviewViews(work.id);
      await query.refetch();
      setReason("");
      action.setSuccess("审核事项已创建");
    });
  }
  async function downloadTypesetHandoffPackage(work: WorkDetail) {
    await action.run(async () => {
      await downloadPrepared({
        purpose: "handoff",
        requireCurrentParticipation: false,
        workId: work.id,
        expectedRevision: work.revision,
        expectedEditorEpoch: work.editorEpoch,
        idempotencyKey: crypto.randomUUID(),
      });
      discardEditorCache();
      await Promise.all([
        query.refetch(),
        queryClient.refetchQueries({
          queryKey: ["typeset-versions", work.id],
          type: "active",
        }),
        invalidateWorkViews(),
      ]);
      action.setSuccess("嵌字交接包已交付浏览器下载");
    });
  }
  return (
    <PermissionGate permission="works:read">
      <Link className="workspace-back" to="/works">
        <ArrowLeft size={16} />
        返回作品
      </Link>
      <PageState query={query}>
        {(work) => {
          const productionWritable =
            work.reviewStatus === "normal" &&
            work.workflowStatus !== "archived";
          const stage = currentStage(work.workflowStatus);
          const joined =
            stage &&
            work.participants.some(
              (item) =>
                item.userId === user.id &&
                item.stage === stage &&
                !item.submittedAt &&
                !item.leftAt,
            );
          const hasHandoffAccess =
            user.roles.some((role) =>
              ["admin", "source", "reviewer"].includes(role),
            ) ||
            work.participants.some(
              (participant) =>
                participant.userId === user.id &&
                ((participant.stage === "translate" &&
                  user.roles.includes("translator")) ||
                  (participant.stage === "proofread" &&
                    user.roles.includes("proofreader")) ||
                  (participant.stage === "typeset" &&
                    user.roles.includes("typesetter"))),
            );
          const hasTypesetParticipation = work.participants.some(
            (participant) =>
              participant.userId === user.id &&
              participant.stage === "typeset" &&
              !participant.leftAt,
          );
          const canManageTypesetVersions =
            productionWritable &&
            (user.permissions.includes("works:admin") ||
              (user.roles.includes("typesetter") && hasTypesetParticipation));
          const canUploadTypesetVersion =
            productionWritable &&
            work.workflowStatus === "typesetting" &&
            Boolean(work.typesetHandoffStartedAt) &&
            user.roles.some(
              (role) => role === "typesetter" || role === "admin",
            ) &&
            work.participants.some(
              (participant) =>
                participant.userId === user.id &&
                participant.stage === "typeset" &&
                !participant.submittedAt &&
                !participant.leftAt,
            );
          const latestTypesetSubmittedAt = work.participants
            .filter(
              (participant) =>
                participant.stage === "typeset" &&
                Boolean(participant.submittedAt) &&
                !participant.leftAt,
            )
            .reduce<string | null>(
              (latest, participant) =>
                participant.submittedAt &&
                (!latest || participant.submittedAt > latest)
                  ? participant.submittedAt
                  : latest,
              null,
            );
          const canCancelTypesetSubmission =
            productionWritable &&
            Boolean(latestTypesetSubmittedAt) &&
            canHandleStage(user, "typeset", work.sourceLanguage) &&
            work.participants.some(
              (participant) =>
                participant.userId === user.id &&
                participant.stage === "typeset" &&
                participant.submittedAt === latestTypesetSubmittedAt &&
                !participant.leftAt,
            );
          const canPreparePublishing =
            user.roles.some((role) =>
              ["admin", "operator", "reviewer"].includes(role),
            ) ||
            (user.roles.includes("typesetter") && hasTypesetParticipation);
          const canConfirmPublication =
            user.permissions.includes("works:publish");
          return (
            <>
              <SectionHeading title={workDisplayTitle(work)}>
                {work.authorName} · {work.imageCount} 页
              </SectionHeading>
              <div className="workspace-page-badges">
                <WorkflowBadge value={work.workflowStatus} />
                <ReviewBadge value={work.reviewStatus} />
                <TranslationAttentionBadge work={work} />
                {work.proofreadingSkipped && (
                  <Badge tone="info">已跳过校对</Badge>
                )}
                <Badge>{sourceLanguageLabels[work.sourceLanguage]}</Badge>
                <Badge
                  tone={work.collaborationMode === "multi" ? "info" : "neutral"}
                >
                  {work.collaborationMode === "multi" ? "多人协作" : "单人模式"}
                </Badge>
                <Link to={`/works/${work.id}/editor`}>
                  <ScanText size={14} />
                  翻译工作区
                </Link>
                {work.sourcePostUrl && (
                  <a
                    className="workspace-source-link"
                    href={work.sourcePostUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看原帖 <ExternalLink size={14} />
                  </a>
                )}
              </div>
              <Feedback error={action.error} success={action.success} />

              <div className="workspace-detail-grid">
                <Surface className="workspace-panel">
                  <div className="workspace-panel-heading">
                    <div>
                      <h2>当前工作</h2>
                      <p>
                        {stage
                          ? `${stageLabels[stage]}阶段`
                          : "当前没有可加入的工作阶段"}
                      </p>
                    </div>
                    {joined &&
                      stage &&
                      (stage === "translate" || stage === "proofread") && (
                        <Link
                          className="account-link"
                          to={`/works/${work.id}/editor`}
                        >
                          进入工作区
                        </Link>
                      )}
                  </div>
                  {stage === "publish" && (
                    <p className="workspace-notice">
                      当前成图已经就绪，请在下方整理发布内容并确认发布。
                    </p>
                  )}
                  {productionWritable &&
                    user.permissions.includes("works:metadata") && (
                      <form
                        key={`metadata-${work.revision}`}
                        className="workspace-work-metadata"
                        onSubmit={(event) => void updateMetadata(event, work)}
                      >
                        <TextField
                          label="作品标题"
                          name="title"
                          defaultValue={work.title ?? ""}
                          maxLength={200}
                          placeholder={`#${work.workNumber} · 待定标题`}
                          required
                        />
                        <Button type="submit" size="sm" loading={action.busy}>
                          保存作品信息
                        </Button>
                      </form>
                    )}
                  <p className="workspace-source-text">
                    {work.sourceText || "原帖没有文字内容。"}
                  </p>
                  <h3>图片</h3>
                  <div className="workspace-image-strip">
                    {work.images.map((image, index) => (
                      <WorkImage
                        key={image.id}
                        workId={work.id}
                        image={image}
                        images={work.images}
                        index={index}
                      />
                    ))}
                  </div>
                  {stage === "typeset" && (
                    <section className="workspace-handoff-panel">
                      <div>
                        <h3>嵌字交接材料</h3>
                        <p>
                          原图与 LabelPlus 翻译文件位于同一个 ZIP
                          根目录，可直接交给嵌字工具使用。
                        </p>
                      </div>
                      {hasHandoffAccess ? (
                        <div className="workspace-inline-actions">
                          <Button
                            loading={action.busy}
                            onClick={() =>
                              void downloadTypesetHandoffPackage(work)
                            }
                          >
                            <Download size={16} />
                            下载嵌字交接包
                          </Button>
                        </div>
                      ) : (
                        <p className="workspace-muted">
                          当前账号没有下载本作品交接材料的权限。
                        </p>
                      )}
                      <small>
                        {work.typesetHandoffStartedAt
                          ? `交接已于 ${dateTime(work.typesetHandoffStartedAt)} 开始，校对内容已冻结。`
                          : "本轮嵌字成员首次成功下载统一交接包后，将冻结校对最终版本；检查用途下载不会推进流程。"}
                      </small>
                    </section>
                  )}
                </Surface>
                <Surface className="workspace-panel workspace-coordination">
                  <div className="workspace-panel-heading">
                    <div>
                      <h2>任务组协调</h2>
                      <p>可提前认领后续职责；多人处理时再加入协作。</p>
                    </div>
                    {user.permissions.includes("works:admin") && (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={action.busy}
                        onClick={() => void updateCollaboration(work)}
                      >
                        {work.collaborationMode === "single"
                          ? "开启多人协作"
                          : "切回单人模式"}
                      </Button>
                    )}
                  </div>
                  <div className="workspace-stage-list">
                    {user.canSkipProofreading &&
                      productionWritable &&
                      work.workflowStatus === "pending_proofread" && (
                        <SkipProofreadingButton
                          workId={id}
                          available={work.canSkipProofreading}
                          reason={work.skipProofreadingUnavailableReason}
                          disabled={action.busy}
                          onSkipped={async (updated) => {
                            queryClient.setQueryData(["work", id], updated);
                            discardEditorCache();
                            await invalidateWorkViews(id);
                          }}
                        />
                      )}
                    {coordinationStages.map((itemStage) => {
                      const latestByUser = new Map<
                        string,
                        WorkDetail["participants"][number]
                      >();
                      for (const person of work.participants) {
                        if (person.stage !== itemStage || person.leftAt)
                          continue;
                        const previous = latestByUser.get(person.userId);
                        if (
                          !previous ||
                          (!person.submittedAt && previous.submittedAt) ||
                          (Boolean(person.submittedAt) ===
                            Boolean(previous.submittedAt) &&
                            person.joinedAt > previous.joinedAt)
                        ) {
                          latestByUser.set(person.userId, person);
                        }
                      }
                      const participants = [...latestByUser.values()].sort(
                        (left, right) =>
                          left.joinedAt.localeCompare(right.joinedAt),
                      );
                      const activeParticipants = participants.filter(
                        (person) => !person.submittedAt,
                      );
                      const hasCurrentUser = participants.some(
                        (person) =>
                          person.userId === user.id && !person.submittedAt,
                      );
                      const isCurrent = stage === itemStage;
                      const canSelf =
                        !(
                          itemStage === "proofread" && work.proofreadingSkipped
                        ) &&
                        canHandleStage(user, itemStage, work.sourceLanguage);
                      return (
                        <div
                          className={`workspace-stage-row${isCurrent ? " is-current" : ""}`}
                          key={itemStage}
                        >
                          <div className="workspace-stage-label">
                            <strong>{stageLabels[itemStage]}</strong>
                            <small>{isCurrent ? "当前阶段" : "职责"}</small>
                          </div>
                          <div className="workspace-stage-people">
                            {participants.length ? (
                              participants.map((person) => (
                                <div key={person.id}>
                                  <span>
                                    <span className="workspace-participant-name">
                                      <MemberAvatar
                                        member={{
                                          id: person.userId,
                                          displayName: person.displayName,
                                          avatarVersion: person.avatarVersion,
                                        }}
                                        size="sm"
                                      />
                                      {person.displayName}
                                    </span>
                                    <small>
                                      {person.submittedAt
                                        ? `已完成 · 提交时署名：${person.creditNameSnapshot ?? person.displayName}`
                                        : person.participationMode === "owner"
                                          ? "负责人"
                                          : "协作者"}
                                      {!person.submittedAt &&
                                      person.contributionCurrent
                                        ? " · 已完成分工"
                                        : ""}
                                    </small>
                                  </span>
                                  {person.userId === user.id &&
                                    work.workflowStatus !== "published" &&
                                    productionWritable && (
                                      <div className="workspace-credit-editor">
                                        <TextField
                                          label={`${stageLabels[itemStage]}临时署名`}
                                          value={
                                            temporaryCredits[person.id] ??
                                            person.workCreditName ??
                                            ""
                                          }
                                          placeholder={person.displayName}
                                          hint={`仅用于本作品的${stageLabels[itemStage]}职责；留空使用成员昵称。`}
                                          maxLength={100}
                                          onChange={(event) =>
                                            setTemporaryCredits((current) => ({
                                              ...current,
                                              [person.id]: event.target.value,
                                            }))
                                          }
                                        />
                                        <Button
                                          size="sm"
                                          variant="secondary"
                                          loading={action.busy}
                                          onClick={() =>
                                            void updateStageCredit(
                                              work,
                                              person,
                                              itemStage,
                                            )
                                          }
                                        >
                                          保存署名
                                        </Button>
                                      </div>
                                    )}
                                  {productionWritable &&
                                    !person.submittedAt &&
                                    work.collaborationMode === "multi" &&
                                    (person.userId === user.id ||
                                      user.permissions.includes(
                                        "works:admin",
                                      )) &&
                                    (itemStage === "translate" ||
                                      itemStage === "proofread") && (
                                      <PageAssignmentEditor
                                        work={work}
                                        participant={person}
                                        onUpdated={(updated) =>
                                          queryClient.setQueryData(
                                            ["work", id],
                                            updated,
                                          )
                                        }
                                      />
                                    )}
                                </div>
                              ))
                            ) : (
                              <span className="workspace-muted">
                                {itemStage === "proofread" &&
                                work.proofreadingSkipped
                                  ? "已跳过校对"
                                  : "尚未分配"}
                              </span>
                            )}
                          </div>
                          <div className="workspace-stage-action">
                            {!activeParticipants.length &&
                              (isCurrent || !participants.length) &&
                              productionWritable &&
                              (canSelf ? (
                                <Button
                                  size="sm"
                                  loading={action.busy}
                                  onClick={() =>
                                    void claimStage(work, itemStage)
                                  }
                                >
                                  认领
                                </Button>
                              ) : null)}
                            {activeParticipants.length > 0 &&
                              isCurrent &&
                              canSelf &&
                              productionWritable &&
                              (work.collaborationMode === "multi" &&
                              !hasCurrentUser ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() =>
                                    void stageAction(work, itemStage)
                                  }
                                >
                                  加入协作
                                </Button>
                              ) : null)}
                            {activeParticipants.length > 0 &&
                              work.collaborationMode === "single" &&
                              isCurrent &&
                              !hasCurrentUser && (
                                <span className="workspace-muted">
                                  单人模式，仅查看
                                </span>
                              )}
                            {hasCurrentUser && productionWritable && (
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={action.busy}
                                onClick={() => void leaveStage(work, itemStage)}
                              >
                                取消接取
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {user.permissions.includes("works:review:raise") &&
                    !work.openReviewCaseId &&
                    productionWritable && (
                      <form
                        className="workspace-stacked-form"
                        onSubmit={(e) => void openReview(work, e)}
                      >
                        <TextField
                          required
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          label="审核理由"
                          maxLength={2000}
                          placeholder="说明原作品需要讨论的问题"
                        />
                        <Button
                          size="sm"
                          type="submit"
                          loading={action.busy}
                          disabled={!reason.trim()}
                        >
                          内容审核
                        </Button>
                      </form>
                    )}
                  {work.openReviewCaseId && (
                    <ReviewRequestActions
                      reviewId={work.openReviewCaseId}
                      workId={work.id}
                      onUpdated={() => query.refetch()}
                    />
                  )}
                </Surface>
              </div>
              {[
                "pending_typeset",
                "typesetting",
                "pending_publish",
                "published",
                "archived",
              ].includes(work.workflowStatus) && (
                <TypesetVersionPanel
                  work={work}
                  canManage={canManageTypesetVersions}
                  canUpload={canUploadTypesetVersion}
                  canCancelSubmission={canCancelTypesetSubmission}
                  onUpdated={() =>
                    Promise.all([query.refetch(), invalidateWorkViews(work.id)])
                  }
                  onWorkUpdated={() =>
                    Promise.all([query.refetch(), invalidateWorkViews(work.id)])
                  }
                />
              )}
              {["pending_publish", "published"].includes(work.workflowStatus) &&
                canPreparePublishing && (
                  <PublishingPanel
                    work={work}
                    canConfirm={canConfirmPublication}
                    onUpdated={() =>
                      Promise.all([
                        query.refetch(),
                        invalidateWorkViews(work.id),
                      ])
                    }
                  />
                )}
              <Surface className="workspace-panel workspace-events">
                <h2>事件记录</h2>
                <ol className="workspace-timeline">
                  {work.events.map((item) => (
                    <li key={item.id}>
                      <span />
                      <div>
                        <strong>
                          {eventLabels[item.action] ?? item.action}
                        </strong>
                        <p>{item.actorName ?? "系统"}</p>
                        <time>{dateTime(item.createdAt)}</time>
                      </div>
                    </li>
                  ))}
                </ol>
              </Surface>
            </>
          );
        }}
      </PageState>
    </PermissionGate>
  );
}
function WorkImage({
  workId,
  image,
  images,
  index,
}: {
  workId: string;
  image: components["schemas"]["WorkImageDto"];
  images: components["schemas"]["WorkImageDto"][];
  index: number;
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const query = useImageUrl(
    ["thumbnail", "work-image", workId, image.id],
    async () =>
      unwrap(
        await client.GET("/api/works/{workId}/images/{imageId}/url", {
          params: {
            path: { workId, imageId: image.id },
            query: { variant: "thumbnail" },
          },
        }),
      ),
  );
  const lightboxImage =
    lightboxIndex === null ? undefined : images[lightboxIndex];
  const lightboxQuery = useImageUrl(
    ["work-image", workId, lightboxImage?.id],
    async () =>
      unwrap(
        await client.GET("/api/works/{workId}/images/{imageId}/url", {
          params: { path: { workId, imageId: lightboxImage!.id } },
        }),
      ),
    Boolean(lightboxImage),
  );
  const safe = isDisplayableImageUrl(query.data?.url);
  return (
    <>
      <button
        type="button"
        className="workspace-image-button"
        aria-label={`查看第 ${image.orderIndex + 1} 页大图`}
        onClick={() => setLightboxIndex(index)}
      >
        {safe ? (
          <img src={query.data!.url!} alt={`第 ${image.orderIndex + 1} 页`} />
        ) : (
          <ImageIcon />
        )}
        <span>{image.orderIndex + 1}</span>
      </button>
      {lightboxIndex !== null && (
        <ImageLightbox
          src={
            isDisplayableImageUrl(lightboxQuery.data?.url)
              ? lightboxQuery.data!.url
              : undefined
          }
          alt={`作品第 ${lightboxIndex + 1} 页`}
          index={lightboxIndex}
          count={images.length}
          thumbnailSrc={
            lightboxIndex === index && isDisplayableImageUrl(query.data?.url)
              ? query.data!.url
              : undefined
          }
          loading={lightboxQuery.isPending}
          onClose={() => setLightboxIndex(null)}
          onPrevious={
            lightboxIndex > 0
              ? () => setLightboxIndex((value) => (value ?? 1) - 1)
              : undefined
          }
          onNext={
            lightboxIndex < images.length - 1
              ? () => setLightboxIndex((value) => (value ?? -1) + 1)
              : undefined
          }
        />
      )}
    </>
  );
}

export function ReviewsPage() {
  const [status, setStatus] = useState("open");
  const query = useApiQuery(["reviews", status], async () =>
    unwrap(
      await client.GET("/api/reviews", {
        params: {
          query: {
            status: (status === "discarded"
              ? "resolved"
              : status) as components["schemas"]["ReviewCaseStatus"],
            discardedOnly: status === "discarded" ? "true" : undefined,
            limit: 100,
          },
        },
      }),
    ),
  );
  return (
    <PermissionGate permission="works:read">
      <SectionHeading title="审核队列">
        统一查看挂起问题、处理历史与可恢复的舍弃作品。
      </SectionHeading>
      <Toolbar>
        <SelectField
          aria-label="审核状态"
          value={status}
          onValueChange={setStatus}
        >
          <option value="open">待处理</option>
          <option value="resolved">已处理</option>
          <option value="discarded">已舍弃 · 可恢复</option>
        </SelectField>
      </Toolbar>
      <PageState query={query} empty={(data) => !data.items.length}>
        {(data) => {
          const items = data.items;
          return (
            <div className="workspace-review-list">
              {items.map((review) => (
                <Link to={`/reviews/${review.id}`} key={review.id}>
                  <Surface>
                    <div>
                      <Badge tone="info">问题审核</Badge>
                      <h2>{review.workTitle}</h2>
                      <p>
                        {review.authorName} · {review.reason}
                      </p>
                    </div>
                    <div>
                      <ReviewBadge value={review.reviewStatus} />
                      <time>{dateTime(review.createdAt)}</time>
                    </div>
                  </Surface>
                </Link>
              ))}
            </div>
          );
        }}
      </PageState>
    </PermissionGate>
  );
}

function ReviewEvidencePanel({ review }: { review: Review }) {
  const user = useAccount();
  const query = useApiQuery(["work", review.workId], async () =>
    unwrap(
      await client.GET("/api/works/{id}", {
        params: { path: { id: review.workId } },
      }),
    ),
  );
  const showsTypesetEvidence =
    Boolean(review.openedTypesetVersionId) ||
    ["pending_typeset", "typesetting", "pending_publish", "published"].includes(
      review.openedFromWorkflowStatus,
    );
  const showsPublishingEvidence =
    user.permissions.includes("reviews:resolve") &&
    ["pending_publish", "published"].includes(review.workflowStatus);

  return (
    <PageState query={query}>
      {(work) => (
        <div className="workspace-review-evidence">
          <Surface className="workspace-panel">
            <div className="workspace-panel-heading">
              <div>
                <h2>原图与译文</h2>
                <p>结合原图和服务器当前译文核对问题。</p>
              </div>
              <Link className="account-link" to={`/works/${work.id}/editor`}>
                <ScanText size={16} />
                打开译文工作区
              </Link>
            </div>
            <div className="workspace-image-grid">
              {work.images.map((image, index) => (
                <WorkImage
                  workId={work.id}
                  image={image}
                  images={work.images}
                  index={index}
                  key={image.id}
                />
              ))}
            </div>
          </Surface>
          {showsTypesetEvidence && (
            <TypesetVersionPanel
              work={work}
              canManage={false}
              canUpload={false}
              reviewSnapshotVersionId={review.openedTypesetVersionId}
              onUpdated={async () => query.refetch()}
              onWorkUpdated={async () => query.refetch()}
            />
          )}
          {showsPublishingEvidence && (
            <PublishingPanel
              work={work}
              canConfirm={false}
              onUpdated={async () => query.refetch()}
            />
          )}
          <Surface className="workspace-panel workspace-events">
            <h2>最近作品事件</h2>
            <ol className="workspace-timeline">
              {work.events.slice(0, 12).map((item) => (
                <li key={item.id}>
                  <span />
                  <div>
                    <strong>{eventLabels[item.action] ?? item.action}</strong>
                    <p>{item.actorName ?? "系统"}</p>
                    <time>{dateTime(item.createdAt)}</time>
                  </div>
                </li>
              ))}
            </ol>
          </Surface>
        </div>
      )}
    </PageState>
  );
}

export function ReviewDetailPage() {
  const { id = "" } = useParams();
  const user = useAccount();
  const action = useAction();
  const query = useApiQuery(["review", id], async () =>
    unwrap(await client.GET("/api/reviews/{id}", { params: { path: { id } } })),
  );
  async function resolve(
    review: Review,
    resolution: "continue_production" | "discard" | "restore_production",
  ) {
    if (
      resolution === "discard" &&
      !window.confirm(
        "舍弃后作品退出正常制作列表，编号、人员和成果保留，可由管理员恢复。确认舍弃吗？",
      )
    )
      return;
    await action.run(async () => {
      try {
        const updated = await unwrap(
          await client.POST("/api/reviews/{id}/resolve", {
            params: { path: { id } },
            body: {
              expectedRevision: review.workRevision,
              expectedEditorEpoch: review.editorEpoch,
              idempotencyKey: crypto.randomUUID(),
              resolution,
              confirmDiscard: resolution === "discard",
            },
          }),
        );
        queryClient.setQueryData(["review", id], updated);
        await refreshReviewViews(review.workId);
        action.setSuccess(
          resolution === "discard"
            ? "作品已舍弃，成果及历史保留"
            : "已恢复原制作进度",
        );
      } catch (error) {
        await refreshReviewViews(review.workId).catch(() => undefined);
        await query.refetch();
        throw error;
      }
    });
  }
  return (
    <PermissionGate permission="works:read">
      <div className="account-content-boundary workspace-review-detail">
        <Link className="workspace-back" to="/reviews">
          <ArrowLeft size={16} />
          返回审核队列
        </Link>
        <PageState query={query}>
          {(review) => (
            <>
              <SectionHeading title={review.workTitle}>
                {review.authorName} · 由 {review.openedByName} 发起
              </SectionHeading>
              <div className="workspace-page-badges">
                <WorkflowBadge value={review.workflowStatus} />
                <ReviewBadge value={review.reviewStatus} />
                <Badge>
                  {review.status === "open"
                    ? "待处理"
                    : review.resolution === "withdrawn"
                      ? "已撤销"
                      : "已处理"}
                </Badge>
              </div>
              {review.status === "open" && (
                <p className="workspace-notice" role="status">
                  作品制作暂停，原阶段、成员和成果保留。管理员确认继续或申请人撤销后按原进度继续。
                </p>
              )}
              <Feedback error={action.error} success={action.success} />
              <div className="workspace-detail-grid workspace-review-decision-grid">
                <Surface className="workspace-panel">
                  <h2>审核理由</h2>
                  <blockquote>{review.reason}</blockquote>
                  <dl className="workspace-description">
                    <div>
                      <dt>发起时间</dt>
                      <dd>{dateTime(review.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>发起时阶段</dt>
                      <dd>{workflowLabels[review.openedFromWorkflowStatus]}</dd>
                    </div>
                    <div>
                      <dt>发起时成图</dt>
                      <dd>
                        {review.openedTypesetVersionNumber
                          ? `v${review.openedTypesetVersionNumber}`
                          : "尚无成图"}
                      </dd>
                    </div>
                    {review.resolution && (
                      <>
                        <div>
                          <dt>处理结果</dt>
                          <dd>{reviewResolutionLabels[review.resolution]}</dd>
                        </div>
                        <div>
                          <dt>处理人</dt>
                          <dd>{review.resolvedByName || "—"}</dd>
                        </div>
                        <div>
                          <dt>处理时间</dt>
                          <dd>
                            {review.resolvedAt
                              ? dateTime(review.resolvedAt)
                              : "—"}
                          </dd>
                        </div>
                        {review.resolutionNote && (
                          <div>
                            <dt>历史处理备注</dt>
                            <dd>{review.resolutionNote}</dd>
                          </div>
                        )}
                      </>
                    )}
                    {review.restoredAt && (
                      <div>
                        <dt>恢复时间</dt>
                        <dd>{dateTime(review.restoredAt)}</dd>
                      </div>
                    )}
                  </dl>
                  <div className="workspace-inline-actions">
                    <Link
                      className="account-link"
                      to={`/works/${review.workId}`}
                    >
                      查看作品上下文
                    </Link>
                    <Link
                      className="account-link"
                      to={`/works/${review.workId}/editor`}
                    >
                      查看译文工作区
                    </Link>
                  </div>
                  {review.status === "open" && (
                    <ReviewRequestActions
                      reviewId={review.id}
                      workId={review.workId}
                      showLink={false}
                      disabled={action.busy}
                      onUpdated={async () => query.refetch()}
                    />
                  )}
                </Surface>
                {user.roles.includes("admin") &&
                  (review.status === "open" || review.canRestore) && (
                    <Surface className="workspace-panel">
                      <h2>{review.canRestore ? "恢复制作" : "是否继续制作"}</h2>
                      <p>
                        {review.canRestore
                          ? "恢复原阶段及有效参与关系，作品编号、成果和历史保留。"
                          : "确认继续会解除本次挂起，完整保留原制作进度；舍弃可恢复。"}
                      </p>
                      <div className="workspace-inline-actions">
                        {review.canRestore ? (
                          <Button
                            loading={action.busy}
                            onClick={() =>
                              void resolve(review, "restore_production")
                            }
                          >
                            恢复
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="danger"
                              loading={action.busy}
                              onClick={() => void resolve(review, "discard")}
                            >
                              确认舍弃
                            </Button>
                            <Button
                              loading={action.busy}
                              onClick={() =>
                                void resolve(review, "continue_production")
                              }
                            >
                              确认继续
                            </Button>
                          </>
                        )}
                      </div>
                    </Surface>
                  )}
              </div>
              <ReviewEvidencePanel review={review} />
            </>
          )}
        </PageState>
      </div>
    </PermissionGate>
  );
}
