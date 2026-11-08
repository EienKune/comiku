import { useEffect, useId, useRef, useState } from "react";
import type { components } from "@comiku/api-client";
import { useNavigate } from "react-router";
import { Button, TextField } from "../../components/ui";
import { client, queryClient, unwrap } from "../account/api";
import { useAction } from "../account/use-action";
type Author = components["schemas"]["AuthorDto"];
function ArchiveDialog({
  author,
  onCancel,
  onDone,
}: {
  author: Author;
  onCancel: () => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    title = useId();
  const [name, setName] = useState("");
  const action = useAction();
  useEffect(() => {
    const previous = document.activeElement,
      dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="candidate-discard-dialog"
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!action.busy) onCancel();
      }}
    >
      <h2 id={title}>删除作者</h2>
      <p>将停止此作者的采集并从作者目录移除，已有作品和历史资料会保留。</p>
      <p>
        请输入完整昵称：<strong>{author.displayName}</strong>
      </p>
      <TextField
        label="确认作者昵称"
        value={name}
        disabled={action.busy}
        onChange={(event) => setName(event.target.value)}
        autoComplete="off"
      />
      {action.error && (
        <p role="alert" className="account-error">
          {action.error}
        </p>
      )}
      <footer>
        <Button
          type="button"
          variant="secondary"
          disabled={action.busy}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={name !== author.displayName}
          loading={action.busy}
          onClick={() =>
            void action.run(async () => {
              if (name !== author.displayName) return;
              await unwrap(
                await client.DELETE("/api/authors/{id}", {
                  params: { path: { id: author.id } },
                  body: { expectedRevision: author.revision },
                }),
              );
              await queryClient.invalidateQueries({ queryKey: ["authors"] });
              queryClient.removeQueries({ queryKey: ["author", author.id] });
              queryClient.removeQueries({
                queryKey: ["managed-author", author.id],
              });
              onDone();
            })
          }
        >
          确认删除
        </Button>
      </footer>
    </dialog>
  );
}
export function AuthorArchiveControl({ author }: { author: Author }) {
  const [snapshot, setSnapshot] = useState<Author | null>(null);
  const navigate = useNavigate();
  return (
    <>
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={() => setSnapshot(author)}
      >
        删除作者
      </Button>
      {snapshot && (
        <ArchiveDialog
          author={snapshot}
          onCancel={() => setSnapshot(null)}
          onDone={() => navigate("/authors")}
        />
      )}
    </>
  );
}
