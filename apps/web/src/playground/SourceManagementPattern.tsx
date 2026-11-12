import { useState } from "react";
import { PlatformIcon } from "../components/PlatformIcon";
import { Badge, Button } from "../components/ui";
import "../features/system/system.css";
import "../features/system/source-history.css";

/** Synthetic design examples only: no source, credential or maintenance requests. */
export function SourceManagementPattern() {
  const [scenario, setScenario] = useState<"normal" | "draining" | "unknown">(
    "normal",
  );
  return (
    <section aria-label="图源管理样例">
      <h3>图源管理</h3>
      <div className="playground-row" role="group" aria-label="模拟平台状态">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setScenario("normal")}
        >
          正常
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setScenario("draining")}
        >
          等待排空
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setScenario("unknown")}
        >
          更新结果未知
        </Button>
      </div>
      <div className="system-connection-grid">
        {(["x", "pixiv"] as const).map((platform) => (
          <article className="system-connection-card" key={platform}>
            <div className="system-connection-card-header">
              <span
                className={`system-connection-icon platform-link--${platform}`}
              >
                <PlatformIcon platform={platform} size={26} />
              </span>
              <div className="system-connection-identity">
                <h3>{platform === "x" ? "X" : "Pixiv"}</h3>
                <span>gallery-dl</span>
              </div>
              <Badge
                tone={
                  platform === "x" && scenario !== "normal"
                    ? "warning"
                    : "success"
                }
              >
                {platform === "x" && scenario !== "normal" ? "维护中" : "正常"}
              </Badge>
            </div>
            {platform === "x" && scenario !== "normal" && (
              <p className="system-connection-detail" role="status">
                {scenario === "draining"
                  ? "正在等待 2 项执行结束。"
                  : "更新尚未确认，请继续原操作。"}
              </p>
            )}
          </article>
        ))}
      </div>
      <div className="source-history-summary">
        <div className="source-history-time">
          <span>示例批次</span>
          <span>定时同步</span>
        </div>
        <Badge tone="warning">部分失败</Badge>
        <div className="source-history-counts">
          <span>已结束 340/345 账号</span>
          <span>异常 3 账号</span>
          <span>原图 12 张</span>
        </div>
      </div>
    </section>
  );
}
