import { Button, TextField } from "../../components/ui";
import { ErrorToast } from "../../components/ErrorToast";
import { BirthdaySubscriptions } from "./BirthdayNotificationPanels";
import { BirthdaySettingsConflict } from "./BirthdaySettingsConflict";
import { useBirthdaySettingsEditor } from "./use-birthday-settings-editor";
import "./birthdays.css";

export function BirthdayReminderSettings({ enabled }: { enabled: boolean }) {
  const editor = useBirthdaySettingsEditor("reminders", enabled);
  const { current, query } = editor;
  return (
    <section className="birthday-notification-panel" aria-label="生日提醒设置">
      <ErrorToast message={editor.error} onDismiss={editor.dismissError} />
      <header className="notification-heading notification-section-heading">
        <h3>角色生日</h3>
        {current && (
          <label className="notification-check">
            <input
              type="checkbox"
              aria-label="启用生日提醒"
              checked={current.remindersEnabled}
              disabled={editor.busy || !enabled}
              onChange={(event) =>
                editor.change({ remindersEnabled: event.target.checked })
              }
            />
            全局启用
          </label>
        )}
      </header>

      {query.isPending && <p role="status">正在读取生日设置…</p>}
      {query.isError && (
        <p role="alert">
          生日设置读取失败。
          <Button
            type="button"
            variant="ghost"
            disabled={!enabled}
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
            <div className="birthday-form-grid">
              <fieldset className="birthday-offsets">
                <legend>提醒日期</legend>
                {(
                  [
                    [0, "生日当天"],
                    [1, "提前 1 天"],
                    [7, "提前 7 天"],
                  ] as const
                ).map(([offset, label]) => (
                  <label key={offset} className="notification-check">
                    <input
                      type="checkbox"
                      checked={current.offsetDays.includes(offset)}
                      onChange={(event) =>
                        editor.change({
                          offsetDays: event.target.checked
                            ? [...current.offsetDays, offset].sort(
                                (a, b) => a - b,
                              )
                            : current.offsetDays.filter(
                                (day) => day !== offset,
                              ),
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <TextField
                label="提醒时刻"
                type="time"
                required
                value={current.sendTime}
                onChange={(event) =>
                  editor.change({ sendTime: event.target.value })
                }
              />
            </div>
            <p className="birthday-muted">
              北京时间 · 同一天生日合并为一条摘要
            </p>
            <BirthdaySettingsConflict
              conflict={editor.conflict}
              comparison={editor.comparison}
              onCompare={() => void editor.compare()}
              onAdopt={editor.adopt}
            />
            <div className="notification-actions">
              <Button
                type="submit"
                loading={editor.busy}
                disabled={current.offsetDays.length === 0 || editor.conflict}
              >
                保存生日提醒
              </Button>
              {editor.draft && (
                <Button type="button" variant="ghost" onClick={editor.discard}>
                  放弃草稿
                </Button>
              )}
              <span role="status">{editor.success}</span>
            </div>
          </fieldset>
        </form>
      )}
      <BirthdaySubscriptions enabled={enabled} showHeading={false} />
    </section>
  );
}
