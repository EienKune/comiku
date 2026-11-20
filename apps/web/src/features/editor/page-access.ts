import type { components } from "@comiku/api-client";
import { authenticatedFetch, unwrap } from "../account/api";

export type PageEditor = components["schemas"]["TranslationEditorDto"];
export type PageLease = Pick<
  components["schemas"]["ProofreadLeaseResultDto"],
  "leaseToken" | "editorEpoch" | "expiresAt"
>;
type AcquiredPageLease = PageLease & {
  image: components["schemas"]["TranslationImageDraftDto"];
};
type LeaseRequest = {
  editorInstanceId: string;
  expectedEditorEpoch: number;
  leaseToken?: string;
};
export function requestPageLease(
  workId: string,
  imageId: string,
  body: LeaseRequest & { leaseToken: string },
): Promise<PageLease>;
export function requestPageLease(
  workId: string,
  imageId: string,
  body: LeaseRequest & { leaseToken?: never },
): Promise<AcquiredPageLease>;
export async function requestPageLease(
  workId: string,
  imageId: string,
  body: LeaseRequest,
): Promise<
  PageLease & { image?: components["schemas"]["TranslationImageDraftDto"] }
> {
  const response = await authenticatedFetch(
    `/api/works/${workId}/translations/pages/${imageId}/lease`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Comiku-Request": "1" },
      body: JSON.stringify(body),
    },
  );
  const data = await response.json();
  const lease = await unwrap<
    PageLease & { image?: components["schemas"]["TranslationImageDraftDto"] }
  >({
    response,
    ...(response.ok ? { data } : { error: data }),
  });
  if (
    !body.leaseToken &&
    (!lease.image ||
      lease.image.id !== imageId ||
      !Array.isArray(lease.image.entries))
  ) {
    await releasePageLease(workId, imageId, {
      editorInstanceId: body.editorInstanceId,
      leaseToken: lease.leaseToken,
    }).catch(() => undefined);
    throw new Error("未取得本页最新内容，暂不能编辑。请重试。");
  }
  return lease;
}
export async function releasePageLease(
  workId: string,
  imageId: string,
  body: { editorInstanceId: string; leaseToken: string },
) {
  const response = await authenticatedFetch(
    `/api/works/${workId}/translations/pages/${imageId}/lease`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Comiku-Request": "1" },
      body: JSON.stringify(body),
      keepalive: true,
    },
  );
  if (!response.ok) throw new Error("释放编辑锁失败，请重试");
}

/** An import holds every target page only for its one atomic write. */
export async function acquireImportPageLeases(options: {
  workId: string;
  editorInstanceId: string;
  editorEpoch: number;
  images: components["schemas"]["TranslationImageDraftDto"][];
  targetIds: string[];
  held?: (PageLease & { imageId: string }) | null;
}) {
  const acquired: (PageLease & { imageId: string })[] = [];
  const access: {
    imageId: string;
    editorInstanceId: string;
    leaseToken: string;
  }[] = [];
  const release = async () => {
    await Promise.allSettled(
      acquired.map((lease) =>
        releasePageLease(options.workId, lease.imageId, {
          editorInstanceId: options.editorInstanceId,
          leaseToken: lease.leaseToken,
        }),
      ),
    );
  };
  try {
    for (const imageId of [...new Set(options.targetIds)]) {
      const local = options.images.find((image) => image.id === imageId);
      if (!local) throw new Error("导入目标页已变化，请重新预览。");
      let lease =
        options.held?.imageId === imageId &&
        Date.parse(options.held.expiresAt) > Date.now()
          ? options.held
          : null;
      if (!lease) {
        let fresh: AcquiredPageLease;
        try {
          fresh = await requestPageLease(options.workId, imageId, {
            editorInstanceId: options.editorInstanceId,
            expectedEditorEpoch: options.editorEpoch,
          });
        } catch (error) {
          throw new Error(
            `第 ${local.orderIndex + 1} 页无法取得校对编辑锁：${error instanceof Error ? error.message : "请稍后重试"}`,
            { cause: error },
          );
        }
        lease = { ...fresh, imageId };
        acquired.push(lease);
        if (
          fresh.image.translationRevision !== local.translationRevision ||
          fresh.image.entries.length !== local.entries.length ||
          fresh.image.entries.some(
            (entry, index) =>
              entry.id !== local.entries[index]?.id ||
              entry.revision !== local.entries[index]?.revision,
          )
        )
          throw new Error(
            `第 ${local.orderIndex + 1} 页云端内容已变化，请重新读取并预览导入。`,
          );
      }
      access.push({
        imageId,
        editorInstanceId: options.editorInstanceId,
        leaseToken: lease.leaseToken,
      });
    }
    if (
      acquired.some((lease) => Date.parse(lease.expiresAt) <= Date.now() + 5000)
    )
      throw new Error(
        "部分目标页编辑锁即将过期，本次尚未导入。请重新预览后重试。",
      );
    return { access, release };
  } catch (error) {
    await release();
    throw error;
  }
}
