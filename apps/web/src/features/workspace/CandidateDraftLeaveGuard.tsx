import { useContext, useEffect, useId, useRef } from "react";
import { UNSAFE_DataRouterContext, useBlocker } from "react-router";
import { Button } from "../../components/ui";
function LeaveDialog({
  onStay,
  onLeave,
}: {
  onStay: () => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    title = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="candidate-discard-dialog"
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        onStay();
      }}
    >
      <h2 id={title}>还有尚未入库的图片整理</h2>
      <p>离开此页面将丢弃本地图片整理；已提交的入库操作仍可能在后台完成。</p>
      <footer>
        <Button type="button" variant="secondary" onClick={onStay}>
          继续编辑
        </Button>
        <Button type="button" variant="danger" onClick={onLeave}>
          放弃并离开
        </Button>
      </footer>
    </dialog>
  );
}
function RouterGuard({ dirty }: { dirty: boolean }) {
  const blocker = useBlocker(dirty);
  return blocker.state === "blocked" ? (
    <LeaveDialog
      onStay={() => blocker.reset()}
      onLeave={() => blocker.proceed()}
    />
  ) : null;
}
export function CandidateDraftLeaveGuard({ dirty }: { dirty: boolean }) {
  const router = useContext(UNSAFE_DataRouterContext);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);
  return router ? <RouterGuard dirty={dirty} /> : null;
}
