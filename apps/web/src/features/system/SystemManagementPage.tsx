import { useSearchParams } from "react-router";
import { useAccount } from "../account/account-context";
import { SectionHeading } from "../account/forms";
import { SourceFetchHistory } from "./SourceFetchHistory";
import { NotificationManagement } from "./NotificationManagement";
import "./system.css";

const tabs = [
  { value: "collection", label: "图源采集" },
  { value: "notifications", label: "推送通知" },
] as const;

export function SystemManagementPage() {
  const user = useAccount();
  const [params, setParams] = useSearchParams();
  const active =
    params.get("tab") === "notifications" ? "notifications" : "collection";
  if (!user.permissions.includes("system:manage"))
    return (
      <SectionHeading title="无权访问">系统管理仅向管理员开放。</SectionHeading>
    );
  function select(value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === "notifications") next.set("tab", value);
      else next.delete("tab");
      return next;
    });
  }
  return (
    <>
      <SectionHeading title="系统管理" />
      <div className="system-tabs" role="tablist" aria-label="系统管理">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            id={`system-tab-${tab.value}`}
            role="tab"
            aria-controls={`system-panel-${tab.value}`}
            aria-selected={active === tab.value}
            tabIndex={active === tab.value ? 0 : -1}
            onClick={() => select(tab.value)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
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
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id="system-panel-collection"
        role="tabpanel"
        aria-labelledby="system-tab-collection"
        hidden={active !== "collection"}
        tabIndex={0}
      >
        <SourceFetchHistory enabled={active === "collection"} />
      </div>
      <div
        id="system-panel-notifications"
        role="tabpanel"
        aria-labelledby="system-tab-notifications"
        hidden={active !== "notifications"}
        tabIndex={0}
      >
        <NotificationManagement enabled={active === "notifications"} />
      </div>
    </>
  );
}
