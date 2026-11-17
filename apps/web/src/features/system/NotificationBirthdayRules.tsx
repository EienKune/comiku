import { useState } from "react";
import { BirthdayReminderSettings } from "../birthdays/BirthdayReminderSettings";
import { BirthdayTemplate } from "../birthdays/BirthdayNotificationPanels";
export function NotificationBirthdayRules({ enabled }: { enabled: boolean }) {
  const [previewHost, setPreviewHost] = useState<HTMLElement | null>(null);
  return (
    <div className="notification-birthday-global-layout">
      <div>
        <BirthdayReminderSettings enabled={enabled} showSubscriptions={false} />
        <BirthdayTemplate enabled={enabled} previewHost={previewHost} />
      </div>
      <aside ref={setPreviewHost}>
        <h3>消息预览</h3>
      </aside>
    </div>
  );
}
