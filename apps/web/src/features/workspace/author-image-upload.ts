import type { components } from "@comiku/api-client";
import { authenticatedFetch, client, unwrap } from "../account/api";
import { pollTransfer } from "./transfers-api";
import {
  typesetUploadContentType,
  uploadFileChecksum,
} from "./typeset-upload-plan";

type Session = components["schemas"]["DirectUploadDto"];
type Input = Pick<
  components["schemas"]["CreateDirectUploadDto"],
  "resourceId" | "expectedRevision"
> & {
  purpose: "author_avatar" | "author_evidence";
};

// Kept by one author form only. A known session must be inspected before a new
// session can replace it: attachment adoption and session completion are atomic.
export class AuthorImageUpload {
  private session: Session | null = null;
  private uploaded = new Set<number>();
  private missingResult = false;

  get resultUnknown() {
    return this.missingResult;
  }

  resetUnknown() {
    if (!this.missingResult) return false;
    this.session = null;
    this.uploaded.clear();
    this.missingResult = false;
    return true;
  }

  private unknownResult() {
    return new Error("上传结果暂无法确认，请先核对作者资料后重新选择文件");
  }

  private pendingExpired() {
    return (
      this.session?.status === "pending" &&
      Date.parse(this.session.expiresAt) <= Date.now()
    );
  }

  get locked() {
    return (
      this.session !== null &&
      ["pending", "queued", "processing"].includes(this.session.status)
    );
  }

  async upload(input: Input, files: File[]) {
    if (this.missingResult) throw this.unknownResult();
    if (this.session) {
      const result = await client.GET("/api/transfers/uploads/{id}", {
        params: { path: { id: this.session.id } },
      });
      if (result.response.status === 404) {
        this.missingResult = true;
        throw this.unknownResult();
      }
      this.session = await unwrap(result);
      if (
        ["failed", "expired"].includes(this.session.status) ||
        this.pendingExpired()
      ) {
        this.session = null;
        this.uploaded.clear();
      }
    }
    if (!this.session) {
      const descriptors = [];
      for (const file of files) {
        const contentType = typesetUploadContentType(file);
        if (contentType === "application/zip")
          throw new Error("请选择 PNG、JPEG 或 WebP 图片");
        descriptors.push({
          sourceName: file.name,
          contentType,
          size: file.size,
          checksum: await uploadFileChecksum(file),
        });
      }
      this.session = await unwrap(
        await client.POST("/api/transfers/uploads", {
          body: { ...input, files: descriptors },
        }),
      );
    }
    if (this.session.status === "pending") {
      for (const [index, file] of files.entries()) {
        if (this.uploaded.has(index)) continue;
        const target = this.session.files[index]?.upload;
        if (!target)
          throw new Error("上传地址已过期，请继续保存以刷新上传地址");
        const response = await authenticatedFetch(target.url, {
          method: "PUT",
          headers: target.headers,
          body: file,
          credentials: target.url.startsWith("/api/") ? "include" : "omit",
        });
        if (!response.ok) throw new Error(`上传失败：${file.name}`);
        this.uploaded.add(index);
      }
      this.session = await unwrap(
        await client.POST("/api/transfers/uploads/{id}/finalize", {
          params: { path: { id: this.session.id } },
          body: {},
        }),
      );
    }
    this.session = await pollTransfer(
      this.session,
      async () => {
        const result = await client.GET("/api/transfers/uploads/{id}", {
          params: { path: { id: this.session!.id } },
        });
        if (result.response.status === 404) {
          this.missingResult = true;
          throw this.unknownResult();
        }
        this.session = await unwrap(result);
        return this.session;
      },
      ["queued", "processing"],
    );
  }
}
