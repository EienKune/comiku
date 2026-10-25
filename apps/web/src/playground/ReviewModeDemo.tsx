import { useState } from "react";
import { Badge, Button, Surface, TextField } from "../components/ui";

export function ReviewModeDemo() {
  const [mode, setMode] = useState<"normal" | "paused" | "discarded">("normal");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("原进度、负责人和成果保留。");
  function continueWork(message: string) {
    setMode("normal");
    setMessage(message);
  }
  return (
    <div className="workspace-review-detail">
      <h3>内容审核 · 模拟</h3>
      <Badge tone={mode === "normal" ? "success" : "warning"}>
        {mode === "normal"
          ? "正常制作"
          : mode === "paused"
            ? "只读挂起"
            : "已舍弃 · 可恢复"}
      </Badge>
      <p className="workspace-notice" role="status">
        {message}
      </p>
      <div className="workspace-detail-grid workspace-review-decision-grid">
        <Surface className="workspace-panel">
          <h3>审核理由 · 模拟</h3>
          {mode === "normal" ? (
            <TextField
              label="审核理由"
              value={reason}
              maxLength={2000}
              placeholder="说明原作品可能存在的问题"
              onChange={(event) => setReason(event.target.value)}
            />
          ) : (
            <blockquote>{reason}</blockquote>
          )}
          <div className="workspace-inline-actions">
            {mode === "normal" ? (
              <Button
                size="sm"
                disabled={!reason.trim()}
                onClick={() => {
                  setMode("paused");
                  setMessage(
                    "等待管理员判断是否继续，制作操作暂停；人员、成果和交接记录保留。",
                  );
                }}
              >
                内容审核
              </Button>
            ) : mode === "paused" ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  continueWork("申请人已撤销请求，恢复原制作进度。")
                }
              >
                撤销审核请求
              </Button>
            ) : null}
          </div>
          <p className="account-hint">
            仅为视觉模拟：实际界面中撤销限申请人，决定与恢复限管理员。
          </p>
        </Surface>
        <Surface className="workspace-panel">
          <h3>{mode === "discarded" ? "恢复制作" : "是否继续制作"} · 模拟</h3>
          <p>
            {mode === "normal"
              ? "暂无待处理请求，制作按正常流程推进。"
              : "人员、成果及原制作进度保留，确认继续或恢复后按原进度推进。"}
          </p>
          <div className="workspace-inline-actions">
            {mode === "paused" ? (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setMode("discarded");
                    setMessage(
                      "管理员确认舍弃，保留作品编号、人员与历史成果。",
                    );
                  }}
                >
                  确认舍弃
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    continueWork(
                      "管理员确认继续，按原进度制作，无需重新认领、提交或下载。",
                    )
                  }
                >
                  确认继续
                </Button>
              </>
            ) : mode === "discarded" ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  continueWork(
                    "管理员已恢复原制作进度，已有正常交接冻结边界保持。",
                  )
                }
              >
                恢复
              </Button>
            ) : null}
          </div>
        </Surface>
      </div>
    </div>
  );
}
