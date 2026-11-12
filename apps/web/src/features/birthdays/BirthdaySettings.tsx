import { useState } from "react";
import { Button, Surface } from "../../components/ui";
import { ErrorToast } from "../../components/ErrorToast";
import { client, unwrap } from "../account/api";
import { BirthdaySettingsConflict } from "./BirthdaySettingsConflict";
import { useBirthdaySettingsEditor } from "./use-birthday-settings-editor";
import "./birthdays.css";

export function BirthdaySettings({ enabled = true }: { enabled?: boolean }) {
  const editor = useBirthdaySettingsEditor("display", enabled);
  const { current, query } = editor;
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState("");
  async function sync() {
    setSyncing(true);
    setSyncNote("");
    try {
      const result = await unwrap(await client.POST("/api/birthdays/sync"));
      setSyncNote(result.queued ? "已安排同步。" : "同步已在进行中。");
    } catch {
      /* Synchronization errors belong to technical logs. */
    } finally {
      setSyncing(false);
    }
  }
  return (
    <div className="birthday-settings">
      <ErrorToast message={editor.error} onDismiss={editor.dismissError} />
      <Surface>
        <header className="birthday-panel-heading">
          <h2>生日数据</h2>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={syncing}
            disabled={!enabled || !query.data?.available}
            onClick={() => void sync()}
          >
            手动同步
          </Button>
        </header>
        {query.data && (
          <p>
            {query.data.personCount} 位角色
            {query.data.dataUpdatedAt && (
              <>
                {" "}
                · 更新于{" "}
                {new Date(query.data.dataUpdatedAt).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })}
              </>
            )}
          </p>
        )}
        <p className="birthday-muted">每天 06:00 同步 · Asia/Shanghai</p>
        {syncNote && <p role="status">{syncNote}</p>}
      </Surface>
      {query.isPending && <p role="status">正在读取生日设置…</p>}
      {query.isError && (
        <p role="alert">
          生日设置读取失败。
          <Button
            type="button"
            variant="ghost"
            onClick={() => void query.refetch()}
          >
            重试
          </Button>
        </p>
      )}
      {current && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void editor.save();
          }}
        >
          <fieldset
            className="birthday-settings-fields"
            disabled={editor.busy || !enabled}
          >
            <Surface>
              <header className="birthday-panel-heading">
                <h2>工作台展示</h2>
                <label className="birthday-check">
                  <input
                    type="checkbox"
                    checked={current.displayEnabled}
                    onChange={(event) =>
                      editor.change({ displayEnabled: event.target.checked })
                    }
                  />
                  启用工作台生日
                </label>
              </header>
              <p className="birthday-muted">未来 7 天；空窗展示最近一次</p>
            </Surface>
            <BirthdaySettingsConflict
              conflict={editor.conflict}
              comparison={editor.comparison}
              onCompare={() => void editor.compare()}
              onAdopt={editor.adopt}
            />
            <div className="birthday-save-bar">
              <span role="status">{editor.success}</span>
              <Button
                type="submit"
                loading={editor.busy}
                disabled={editor.conflict}
              >
                保存设置
              </Button>
              {editor.draft && (
                <Button type="button" variant="ghost" onClick={editor.discard}>
                  放弃草稿
                </Button>
              )}
            </div>
          </fieldset>
        </form>
      )}
    </div>
  );
}
