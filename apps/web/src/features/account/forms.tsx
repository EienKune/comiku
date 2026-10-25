import { type ReactNode } from "react";
import { Button } from "../../components/ui";

export function Feedback({
  error,
  success,
}: {
  error?: string;
  success?: string;
}) {
  if (!error && !success) return null;

  return (
    <div className="account-feedback">
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="account-success" role="status">
          {success}
        </p>
      )}
    </div>
  );
}
export function LoadingState() {
  return (
    <div className="account-centered" role="status">
      正在加载账号信息…
    </div>
  );
}
export function ErrorState({ retry }: { retry: () => void }) {
  return (
    <div className="account-centered">
      <p role="alert">暂时无法读取账号信息。</p>
      <Button onClick={retry}>重新加载</Button>
    </div>
  );
}
export function SectionHeading({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="account-heading">
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </header>
  );
}
