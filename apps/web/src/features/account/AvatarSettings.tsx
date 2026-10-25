import { useEffect, useState } from "react";
import { Avatar } from "../../components/Avatar";
import { Button } from "../../components/ui";
import { MemberAvatar } from "./MemberAvatar";
import { refreshMemberProfile } from "./profile-cache";
import { useAccount } from "./account-context";
import { authenticatedFetch, client, unwrap } from "./api";
import { Feedback } from "./forms";
import { useAction } from "./use-action";

export function AvatarSettings() {
  const user = useAccount();
  const action = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string>();
  const [validationError, setValidationError] = useState("");
  useEffect(() => {
    if (!file) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  async function upload() {
    if (!file) return;
    await action.run(async () => {
      const bytes = await file.arrayBuffer();
      const checksum = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      const contentType =
        file.type ||
        ({
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          webp: "image/webp",
          gif: "image/gif",
        }[file.name.split(".").at(-1)?.toLowerCase() ?? ""] ??
          "");
      const session = await unwrap(
        await client.POST("/api/users/me/avatar/upload-sessions", {
          body: {
            sourceName: file.name,
            contentType: contentType as "image/png",
            size: file.size,
            checksum,
            expectedRevision: user.revision,
          },
        }),
      );
      const response = await authenticatedFetch(session.url, {
        method: "PUT",
        headers: session.headers,
        body: file,
      });
      if (!response.ok) throw new Error("头像上传失败，请重新选择图片");
      const updated = await unwrap(
        await client.POST(
          "/api/users/me/avatar/upload-sessions/{id}/complete",
          { params: { path: { id: session.id } }, body: {} },
        ),
      );
      await refreshMemberProfile(updated);
      setFile(null);
      action.setSuccess("头像已更新");
    });
  }
  return (
    <section className="account-avatar-settings" aria-label="个人头像">
      <div className="account-actions">
        {preview ? (
          <Avatar name={user.displayName} src={preview} size="lg" />
        ) : (
          <MemberAvatar member={user} size="lg" />
        )}
        <div>
          <strong>个人头像</strong>
          <p>PNG、JPEG、WebP 或 GIF，最多 5 MiB。</p>
        </div>
      </div>
      <label className="ui-field">
        <span className="ui-field__label">选择头像</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          disabled={action.busy}
          onChange={(event) => {
            const next = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (next && (!next.size || next.size > 5 * 1024 * 1024)) {
              setValidationError("头像为空或超过 5 MiB");
              return;
            }
            setFile(next ?? null);
            setValidationError("");
          }}
        />
      </label>
      <div className="account-actions">
        <Button
          disabled={!file}
          loading={action.busy}
          onClick={() => void upload()}
        >
          保存头像
        </Button>
        {file && (
          <Button
            variant="ghost"
            disabled={action.busy}
            onClick={() => setFile(null)}
          >
            取消选择
          </Button>
        )}
        {user.avatarVersion && (
          <Button
            variant="secondary"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const updated = await unwrap(
                  await client.DELETE("/api/users/me/avatar", {
                    body: { expectedRevision: user.revision },
                  }),
                );
                await refreshMemberProfile(updated);
                setFile(null);
                action.setSuccess("头像已移除");
              })
            }
          >
            移除头像
          </Button>
        )}
      </div>
      <Feedback
        error={validationError || action.error}
        success={action.success}
      />
    </section>
  );
}
