import { useState } from "react";
import { BookOpen, Download, Upload } from "lucide-react";
import { Button, SelectField, Surface } from "../components/ui";
import {
  WorkViewNavigation,
  type WorkPerspective,
} from "../features/workspace/WorkViewNavigation";
import "../features/workspace/work-series.css";
import {
  readingTabs,
  workingTabs,
  type WorkTab,
} from "../features/workspace/work-views";

export function WorkViewsDemo() {
  const [view, setView] = useState<WorkPerspective>("work");
  const [member, setMember] = useState("translator");
  const [tab, setTab] = useState<WorkTab>("todo");
  const [batchHint, setBatchHint] = useState("");
  const roles =
    member === "admin"
      ? (["admin"] as const)
      : member === "source"
        ? (["source"] as const)
        : (["translator", "proofreader", "typesetter"] as const);
  const tabs =
    view === "read"
      ? readingTabs
      : workingTabs({ roles: [...roles], languageCapabilities: ["ja"] });
  const active =
    tabs.find((item) => item.value === tab)?.value ??
    (view === "read" ? "all" : "todo");
  return (
    <div>
      <h3>作品视角</h3>
      <p>
        工作视图处理任务，查看视图浏览作品，系列视图整理连载目录。以下仅为模拟。
      </p>
      <div className="inline-actions">
        <WorkViewNavigation
          active={view}
          onChange={(next) => {
            setView(next);
            setTab(next === "work" ? "todo" : "all");
          }}
        />
        <SelectField label="示例职务" value={member} onValueChange={setMember}>
          <option value="translator">翻校嵌 · 日语</option>
          <option value="admin">仅管理员</option>
          <option value="source">仅图源</option>
        </SelectField>
      </div>
      {view === "series" ? (
        <Surface as="article" className="series-card">
          <div className="series-card-cover">
            <BookOpen size={38} />
          </div>
          <div className="series-card-body">
            <h2>放学后的约定</h2>
            <p>示例作者 · 3 部作品</p>
          </div>
        </Surface>
      ) : (
        <>
          <div
            className="workspace-topbar playground-batch-topbar"
            aria-label="待办顶部动作示例"
          >
            <div className="workspace-topbar-context">
              {view === "work" &&
              active === "todo" &&
              roles.some((role) => role === "typesetter") ? (
                <div className="workspace-topbar-actions">
                  {batchHint && <strong role="status">{batchHint}</strong>}
                  <Button
                    size="sm"
                    variant="secondary"
                    leadingIcon={<Download size={16} />}
                    onClick={() => setBatchHint("演示：打开交接清单")}
                  >
                    批量下载嵌字交接包
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    leadingIcon={<Upload size={16} />}
                    onClick={() => setBatchHint("演示：打开成图上传")}
                  >
                    批量上传成图
                  </Button>
                </div>
              ) : (
                <span className="workspace-topbar-title">当前页面</span>
              )}
            </div>
          </div>
          <div className="tabs" role="tablist" aria-label="作品视角示例分类">
            {tabs.map((item) => (
              <button
                type="button"
                role="tab"
                key={item.value}
                aria-selected={active === item.value}
                onClick={() => setTab(item.value)}
              >
                {item.label}
                <span>0</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
