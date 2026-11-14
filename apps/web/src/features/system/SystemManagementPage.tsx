import { BirthdaySettings } from "../birthdays/BirthdaySettings";
import { useSearchParams } from "react-router";
import { useAccount } from "../account/account-context";
import { SectionHeading } from "../account/forms";
import { SourceManagement } from "./SourceManagement";
import { NotificationManagement } from "./NotificationManagement";
import { AccountsPage } from "../account/AccountsPage";
import { ArchiveExportManagement } from "./ArchiveExportManagement";
import "./system.css";

const tabs = [
  { value: "collection", label: "图源采集", permission: "system:manage" },
  { value: "birthdays", label: "角色生日", permission: "system:manage" },
  { value: "notifications", label: "推送通知", permission: "system:manage" },
  { value: "exports", label: "数据导出", permission: "system:manage" },
  { value: "accounts", label: "账号管理", permission: "accounts:manage" },
] as const;

export function SystemManagementPage() {
  const user = useAccount();
  const [params, setParams] = useSearchParams();
  const visibleTabs = tabs.filter((tab) =>
    user.permissions.includes(tab.permission),
  );
  const active =
    visibleTabs.find((tab) => tab.value === params.get("tab"))?.value ??
    visibleTabs[0]?.value;
  if (!visibleTabs.length)
    return (
      <SectionHeading title="无权访问">系统管理仅向管理员开放。</SectionHeading>
    );
  function select(value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value !== "collection") next.set("tab", value);
      else next.delete("tab");
      return next;
    });
  }
  return (
    <div className="system-management">
      <SectionHeading title="系统管理" />
      <div className="system-tabs" role="tablist" aria-label="系统管理">
        {visibleTabs.map((tab) => (
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
      {user.permissions.includes("system:manage") && (
        <div
          id="system-panel-collection"
          role="tabpanel"
          aria-labelledby="system-tab-collection"
          hidden={active !== "collection"}
          tabIndex={0}
        >
          <SourceManagement enabled={active === "collection"} />
        </div>
      )}
      {user.permissions.includes("system:manage") && (
        <div
          id="system-panel-birthdays"
          role="tabpanel"
          aria-labelledby="system-tab-birthdays"
          hidden={active !== "birthdays"}
          tabIndex={0}
        >
          <BirthdaySettings enabled={active === "birthdays"} />
        </div>
      )}
      {user.permissions.includes("system:manage") && (
        <div
          id="system-panel-notifications"
          role="tabpanel"
          aria-labelledby="system-tab-notifications"
          hidden={active !== "notifications"}
          tabIndex={0}
        >
          <NotificationManagement enabled={active === "notifications"} />
        </div>
      )}
      {user.permissions.includes("system:manage") && (
        <div
          id="system-panel-exports"
          role="tabpanel"
          aria-labelledby="system-tab-exports"
          hidden={active !== "exports"}
          tabIndex={0}
        >
          <ArchiveExportManagement enabled={active === "exports"} />
        </div>
      )}
      {user.permissions.includes("accounts:manage") && (
        <div
          id="system-panel-accounts"
          role="tabpanel"
          aria-labelledby="system-tab-accounts"
          hidden={active !== "accounts"}
          tabIndex={0}
        >
          <AccountsPage enabled={active === "accounts"} />
        </div>
      )}
    </div>
  );
}
