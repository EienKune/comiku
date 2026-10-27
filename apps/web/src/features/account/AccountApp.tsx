import { useLayoutEffect, useState, type ComponentType } from "react";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  FileCheck2,
  Images,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelTopClose,
  PanelTopOpen,
  Sparkles,
  Settings,
  Settings2,
  Users,
} from "lucide-react";
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router";
import { Button, IconButton } from "../../components/ui";
import { applyTheme, readTheme, themeStorageKey } from "../../styles/theme";
import { client, queryClient, unwrap, useMe } from "./api";
import { ErrorState, Feedback, LoadingState } from "./forms";
import { useAction } from "./use-action";
import {
  TopbarActionsContext,
  type TopbarActionRegistration,
} from "./topbar-actions";
import { settingsLinkState, useSettingsNavigation } from "./settings-routing";
import { MemberAvatar } from "./MemberAvatar";
import "./account.css";

type Icon = ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
interface NavItem {
  to: string;
  label: string;
  icon: Icon;
  permission?: string;
}
const navigation: { label: string; items: NavItem[] }[] = [
  {
    label: "工作空间",
    items: [
      {
        to: "/",
        label: "工作台",
        icon: LayoutDashboard,
      },
      { to: "/works", label: "作品", icon: Archive, permission: "works:read" },
      {
        to: "/candidates",
        label: "候选池",
        icon: Images,
        permission: "candidates:read",
      },
      {
        to: "/reviews",
        label: "审核队列",
        icon: FileCheck2,
        permission: "works:read",
      },
    ],
  },
  {
    label: "管理",
    items: [
      {
        to: "/authors",
        label: "授权作者",
        icon: CircleUserRound,
        permission: "authors:read",
      },
      {
        to: "/members",
        label: "团队成员",
        icon: Users,
        permission: "members:read",
      },
      {
        to: "/settings/users",
        label: "账号管理",
        icon: Settings,
        permission: "accounts:manage",
      },
      {
        to: "/settings/system",
        label: "系统管理",
        icon: Settings2,
        permission: "system:manage",
      },
    ],
  },
];

const preferenceKey = "comiku.workspace.layout.v1";
function readLayoutPreference() {
  try {
    return JSON.parse(localStorage.getItem(preferenceKey) ?? "{}") as {
      sidebar?: boolean;
      topbar?: boolean;
    };
  } catch {
    return {};
  }
}

export function AccountLayout() {
  const me = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  const action = useAction();
  const settings = useSettingsNavigation();
  const visiblePath = settings.background?.pathname ?? location.pathname;
  const editorMode = /^\/works\/[^/]+\/editor$/.test(visiblePath);
  const initial = readLayoutPreference();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    initial.sidebar ?? false,
  );
  const [topbarCollapsed, setTopbarCollapsed] = useState(
    initial.topbar ?? false,
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [topbarActions, setTopbarActions] =
    useState<TopbarActionRegistration | null>(null);

  useLayoutEffect(() => {
    applyTheme(readTheme(localStorage.getItem(themeStorageKey)));
  }, []);
  useLayoutEffect(() => {
    try {
      localStorage.setItem(
        preferenceKey,
        JSON.stringify({ sidebar: sidebarCollapsed, topbar: topbarCollapsed }),
      );
    } catch {
      /* Layout preferences may remain session-only. */
    }
  }, [sidebarCollapsed, topbarCollapsed]);
  useLayoutEffect(() => setMobileOpen(false), [location.pathname]);

  if (me.isPending) return <LoadingState />;
  if (me.isError) return <ErrorState retry={() => void me.refetch()} />;
  if (!me.data) return <Navigate to="/login" replace />;
  const user = me.data;
  if (user.mustChangePassword && location.pathname !== "/settings/password")
    return <Navigate to="/settings/password" replace />;
  const restricted = user.mustChangePassword;

  async function logout() {
    await action.run(async () => {
      await unwrap(await client.POST("/api/auth/logout", { body: {} }));
      queryClient.clear();
      queryClient.setQueryData(["me"], null);
      navigate("/login", { replace: true });
    });
  }

  return (
    <TopbarActionsContext.Provider value={setTopbarActions}>
      <div
        className={`account-app${restricted ? " is-restricted" : ""}${editorMode ? " is-editor-mode" : ""}${sidebarCollapsed ? " is-sidebar-collapsed" : ""}${topbarCollapsed ? " is-topbar-collapsed" : ""}`}
      >
        <a className="account-skip" href="#account-main">
          跳到主要内容
        </a>
        {!restricted && !editorMode && (
          <>
            {mobileOpen && (
              <button
                className="workspace-sidebar-backdrop"
                aria-label="关闭导航"
                onClick={() => setMobileOpen(false)}
              />
            )}
            <aside
              className={`workspace-sidebar${mobileOpen ? " is-open" : ""}`}
            >
              <div className="workspace-brand-row">
                <Link className="account-brand" to="/" title="Comiku">
                  <span className="workspace-brand-mark" aria-hidden="true">
                    <span>C</span>
                    <Sparkles size={10} />
                  </span>
                  <span className="workspace-brand-copy">
                    <strong>Comiku</strong>
                    <small>Workspace</small>
                  </span>
                </Link>
                <IconButton
                  className="workspace-sidebar-collapse"
                  label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
                  size="sm"
                  onClick={() => setSidebarCollapsed((value) => !value)}
                >
                  {sidebarCollapsed ? (
                    <ChevronRight size={17} />
                  ) : (
                    <ChevronLeft size={17} />
                  )}
                </IconButton>
              </div>
              <nav aria-label="主导航">
                {navigation.map((group) => {
                  const items = group.items.filter(
                    (item) =>
                      !item.permission ||
                      user.permissions.includes(item.permission),
                  );
                  if (!items.length) return null;
                  return (
                    <section className="workspace-nav-group" key={group.label}>
                      <p>{group.label}</p>
                      {items.map(({ to, label, icon: ItemIcon }) => (
                        <NavLink
                          end={to === "/"}
                          to={to}
                          key={to}
                          title={label}
                          className={() =>
                            (
                              to === "/"
                                ? visiblePath === to
                                : visiblePath === to ||
                                  visiblePath.startsWith(to + "/")
                            )
                              ? "active"
                              : undefined
                          }
                        >
                          {() => (
                            <>
                              <ItemIcon size={17} />
                              <span>{label}</span>
                              {(to === "/"
                                ? visiblePath === to
                                : visiblePath === to ||
                                  visiblePath.startsWith(to + "/")) && (
                                <ChevronRight size={15} />
                              )}
                            </>
                          )}
                        </NavLink>
                      ))}
                    </section>
                  );
                })}
              </nav>
              <div className="workspace-sidebar-footer">
                <Link
                  to="/settings"
                  state={settingsLinkState(location)}
                  title="外观与个人设置"
                >
                  <Settings size={18} />
                  <span>外观与个人设置</span>
                </Link>
                <div
                  className="workspace-user-summary"
                  title={user.displayName}
                >
                  <MemberAvatar member={user} />
                  <span>
                    <strong>{user.displayName}</strong>
                    <small>@{user.username}</small>
                  </span>
                </div>
              </div>
            </aside>
          </>
        )}
        {!restricted && !editorMode && !topbarCollapsed && (
          <header className="workspace-topbar">
            <IconButton
              className="workspace-mobile-menu"
              label="打开导航"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={19} />
            </IconButton>
            <div className="workspace-topbar-context">
              {topbarActions?.content ?? (
                <span className="workspace-topbar-title">共同完成每一页</span>
              )}
            </div>
            <Link
              className="workspace-topbar-user"
              to="/settings"
              state={settingsLinkState(location)}
              aria-label={`个人设置：${user.displayName}`}
            >
              <MemberAvatar member={user} size="sm" />
              <span className="workspace-topbar-user-name">
                {user.displayName}
              </span>
            </Link>
            <IconButton
              label="收起顶部栏"
              onClick={() => setTopbarCollapsed(true)}
            >
              <PanelTopClose size={18} />
            </IconButton>
            <Button
              aria-label="退出"
              variant="ghost"
              leadingIcon={<LogOut size={16} />}
              loading={action.busy}
              onClick={() => void logout()}
            >
              退出
            </Button>
          </header>
        )}
        {!restricted && !editorMode && topbarCollapsed && (
          <IconButton
            className="workspace-topbar-restore"
            label="展开顶部栏"
            onClick={() => setTopbarCollapsed(false)}
          >
            <PanelTopOpen size={18} />
            {topbarActions?.collapsedLabel && (
              <span className="workspace-topbar-restore-label">
                {topbarActions.collapsedLabel}
              </span>
            )}
          </IconButton>
        )}
        <main id="account-main" className="account-main">
          <Feedback error={action.error} />
          <Outlet context={user} />
        </main>
      </div>
    </TopbarActionsContext.Provider>
  );
}
