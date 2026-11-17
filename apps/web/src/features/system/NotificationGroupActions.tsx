import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NotificationGroupFooterContext } from "./notification-group-footer-context";
export function NotificationGroupActions({
  active = true,
  disabled = false,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const footer = useContext(NotificationGroupFooterContext);
  if (!active) return null;
  const actions = (
    <fieldset
      className="notification-group-actions-fieldset"
      disabled={disabled}
    >
      <div className="notification-actions">{children}</div>
    </fieldset>
  );
  return footer ? createPortal(actions, footer) : actions;
}
