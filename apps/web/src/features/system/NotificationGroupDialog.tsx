import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui";
import { NotificationGroupFooterContext } from "./notification-group-footer-context";

export type GroupSection = "basic" | "events" | "work" | "birthday";
export function NotificationGroupDialog({
  open,
  title,
  section,
  onSection,
  onClose,
  children,
  preview,
}: {
  open: boolean;
  title: string;
  section: GroupSection;
  onSection: (section: GroupSection) => void;
  onClose: () => void;
  children: ReactNode;
  preview: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current;
    const opener = document.activeElement as HTMLElement | null;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
    heading.current?.focus({ preventScroll: true });
    return () => {
      if (typeof element.close === "function") element.close();
      else element.removeAttribute("open");
      document.body.style.overflow = previous;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="notification-group-dialog"
      aria-labelledby="notification-group-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="notification-group-heading">
        <h2 ref={heading} tabIndex={-1} id="notification-group-title">
          {title}
        </h2>
        <Button variant="ghost" onClick={onClose} aria-label="关闭群设置">
          关闭
        </Button>
      </header>
      <NotificationGroupFooterContext.Provider value={footer}>
        <div className="notification-group-body">
          <nav className="notification-settings-nav" aria-label="群设置类别">
            {(
              [
                ["basic", "基本信息"],
                ["events", "作品通知"],
                ["work", "工作提醒"],
                ["birthday", "生日提醒"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-current={section === id ? "page" : undefined}
                onClick={() => onSection(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="notification-group-pane">{children}</div>
          <aside className="notification-group-preview">
            <h3>消息预览</h3>
            {preview}
          </aside>
        </div>
      </NotificationGroupFooterContext.Provider>
      <footer ref={setFooter} className="notification-group-footer" />
    </dialog>
  );
}
