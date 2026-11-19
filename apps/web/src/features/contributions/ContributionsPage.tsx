import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { Link } from "react-router";
import { Badge, Button, SelectField, Surface } from "../../components/ui";
import { useAccount } from "../account/account-context";
import { client, unwrap } from "../account/api";
import { SectionHeading } from "../account/forms";
import { workflowLabels } from "../workspace/work-status";
import "./contributions.css";

type Summary = components["schemas"]["ContributionSummaryDto"];
type Metric = keyof Summary["counts"];
const metrics: { key: Metric; label: string }[] = [
  { key: "translate", label: "翻译完成" },
  { key: "proofread", label: "校对完成" },
  { key: "typeset", label: "嵌字完成" },
  { key: "works", label: "有完成贡献的作品" },
  { key: "published", label: "已发布参与作品" },
  { key: "tasks", label: "当前在手任务" },
];
const stages = {
  translate: "翻译",
  proofread: "校对",
  typeset: "嵌字",
  publish: "发布",
};
const formatTime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));

export function ContributionOverview({
  summary,
  selected,
  onSelect,
}: {
  summary: Summary;
  selected: Metric | null;
  onSelect: (metric: Metric) => void;
}) {
  return (
    <div className="contribution-metrics" aria-label="贡献汇总">
      {metrics.map(({ key, label }) => (
        <Button
          key={key}
          variant="secondary"
          className="contribution-metric"
          aria-pressed={selected === key}
          onClick={() => onSelect(key)}
        >
          <span>{label}</span>
          <strong>{summary.counts[key]}</strong>
        </Button>
      ))}
    </div>
  );
}

export function ContributionAchievements({
  achievements,
}: Pick<Summary, "achievements">) {
  return (
    <Surface className="contribution-panel">
      <h2>累计成就</h2>
      <ul className="contribution-achievements">
        {achievements.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.name}</strong>
              {item.achieved && <Badge>已达成</Badge>}
            </div>
            <p>{item.condition}</p>
            <div>
              <progress
                aria-label={item.name}
                value={Math.min(item.progress, item.target)}
                max={item.target}
              />
              <span>
                {Math.min(item.progress, item.target)}/{item.target}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </Surface>
  );
}

export function ContributionsPage() {
  const user = useAccount();
  const admin = user.permissions.includes("accounts:manage");
  const [target, setTarget] = useState("self");
  const visibleTarget = admin ? target : "self";
  const [period, setPeriod] = useState<"month" | "all">("month");
  const members = useQuery({
    queryKey: ["contribution-members"],
    queryFn: async ({ signal }) =>
      unwrap(await client.GET("/api/users", { signal })),
    enabled: admin,
  });
  return (
    <div className="account-content-boundary contribution-page">
      <SectionHeading
        title={
          visibleTarget === "team"
            ? "全组贡献"
            : visibleTarget === "self"
              ? "我的贡献"
              : "成员贡献"
        }
      />
      <div className="contribution-toolbar">
        <div role="group" aria-label="贡献时间范围">
          {(["month", "all"] as const).map((value) => (
            <Button
              key={value}
              variant={period === value ? "primary" : "secondary"}
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {value === "month" ? "本月" : "累计"}
            </Button>
          ))}
        </div>
        {admin && (
          <SelectField
            label="查看范围"
            value={target}
            onValueChange={setTarget}
          >
            <option value="self">我自己</option>
            <option value="team">全组</option>
            {(members.data ?? [])
              .filter((member) => member.id !== user.id)
              .map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName}
                  {member.isActive ? "" : "（已停用）"}
                </option>
              ))}
          </SelectField>
        )}
      </div>
      {admin && members.isError && (
        <p className="account-error" role="alert">
          成员列表读取失败。
          <Button variant="ghost" onClick={() => void members.refetch()}>
            重试
          </Button>
        </p>
      )}
      <ContributionResults
        key={`${visibleTarget}:${period}`}
        target={visibleTarget}
        period={period}
      />
    </div>
  );
}

function ContributionResults({
  target,
  period,
}: {
  target: string;
  period: "month" | "all";
}) {
  const user = useAccount();
  const [metric, setMetric] = useState<Metric | null>(null);
  const [offset, setOffset] = useState(0);
  const query = {
    period,
    scope: target === "team" ? ("team" as const) : ("personal" as const),
    ...(target !== "self" && target !== "team" ? { userId: target } : {}),
  };
  const summary = useQuery({
    queryKey: ["contributions", user.id, target, period],
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/contributions/summary", {
          params: { query },
          signal,
        }),
      ),
    staleTime: 0,
  });
  const details = useQuery({
    queryKey: ["contribution-details", user.id, target, period, metric, offset],
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/contributions/details", {
          params: { query: { ...query, metric: metric!, offset, limit: 20 } },
          signal,
        }),
      ),
    enabled: metric !== null,
    staleTime: 0,
  });
  if (summary.isPending) return <p role="status">正在读取贡献统计…</p>;
  if (summary.isError)
    return (
      <Surface className="contribution-panel">
        <p className="account-error" role="alert">
          贡献统计读取失败：{summary.error.message}
        </p>
        <Button onClick={() => void summary.refetch()}>重试</Button>
      </Surface>
    );
  return (
    <>
      <div className="contribution-summary-heading">
        <span>
          {period === "month" ? summary.data.month : "累计"} · 上海时间
        </span>
        <Button
          variant="ghost"
          onClick={() => {
            void summary.refetch();
            if (metric) void details.refetch();
          }}
          disabled={summary.isFetching || details.isFetching}
        >
          刷新
        </Button>
      </div>
      <ContributionOverview
        summary={summary.data}
        selected={metric}
        onSelect={(value) => {
          setMetric(value);
          setOffset(0);
        }}
      />
      <details className="contribution-method">
        <summary>统计口径</summary>
        <p>
          按成员、作品、职责计算当前有效交付；作品数去重。取消交付后同步重算，重新交付归入新的完成月份。在手任务为当前快照，包含归档中保留的认领。已发布参与作品按首次发布月份计算。全组各职责为成员交付份数；全组作品数按作品去重。未记录个人页数，不估算工时。
        </p>
      </details>
      {metric && (
        <Surface className="contribution-panel" aria-label="贡献作品明细">
          <h2>{metrics.find((item) => item.key === metric)?.label}</h2>
          {details.isPending ? (
            <p role="status">正在读取作品明细…</p>
          ) : details.isError ? (
            <>
              <p className="account-error" role="alert">
                作品明细读取失败：{details.error.message}
              </p>
              <Button onClick={() => void details.refetch()}>重试</Button>
            </>
          ) : (
            <>
              <p>{details.data.total} 项</p>
              {details.data.items.length === 0 ? (
                <p>此范围内暂无记录。</p>
              ) : (
                <ul className="contribution-details">
                  {details.data.items.map((item) => (
                    <li key={item.id}>
                      <div>
                        <Link to={`/works/${item.workId}`}>
                          #{item.workNumber} · {item.title || "待定标题"}
                        </Link>
                        <Badge>{workflowLabels[item.workflowStatus]}</Badge>
                      </div>
                      {metric === "published" && item.publishedAt && (
                        <p>首次发布：{formatTime(item.publishedAt)}</p>
                      )}
                      <ul>
                        {item.contributions.map((credit) => (
                          <li key={`${credit.userId}:${credit.stage}`}>
                            <span>
                              {credit.displayName} · {stages[credit.stage]}
                            </span>
                            <span>
                              {credit.completedAt
                                ? formatTime(credit.completedAt)
                                : "在手"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
              <div className="contribution-pagination">
                <Button
                  variant="secondary"
                  disabled={offset === 0 || details.isFetching}
                  onClick={() => setOffset(Math.max(0, offset - 20))}
                >
                  上一页
                </Button>
                <span>
                  {details.data.total === 0
                    ? 0
                    : Math.min(offset + 1, details.data.total)}
                  –{Math.min(offset + 20, details.data.total)} /{" "}
                  {details.data.total}
                </span>
                <Button
                  variant="secondary"
                  disabled={
                    offset + 20 >= details.data.total || details.isFetching
                  }
                  onClick={() => setOffset(offset + 20)}
                >
                  下一页
                </Button>
              </div>
            </>
          )}
        </Surface>
      )}
      {summary.data.achievements.length > 0 && (
        <ContributionAchievements achievements={summary.data.achievements} />
      )}
    </>
  );
}
