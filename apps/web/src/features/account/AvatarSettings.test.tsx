import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AvatarSettings } from "./AvatarSettings";

const mocks = vi.hoisted(() => ({
  user: {
    id: "00000000-0000-4000-8000-000000000002",
    displayName: "合成成员",
    revision: 7,
    avatarVersion: "original-avatar",
  },
  post: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./account-context", () => ({ useAccount: () => mocks.user }));
vi.mock("./MemberAvatar", () => ({
  MemberAvatar: () => <span>已保存头像</span>,
}));
vi.mock("./profile-cache", () => ({ refreshMemberProfile: mocks.refresh }));
vi.mock("./api", () => ({
  client: { POST: mocks.post, DELETE: mocks.remove },
  authenticatedFetch: mocks.upload,
  unwrap: async (result: { data: unknown }) => result.data,
}));

beforeEach(() => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:personal-avatar"),
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.stubGlobal("crypto", {
    subtle: { digest: vi.fn(async () => new Uint8Array([0, 15, 255]).buffer) },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function select(file: File) {
  fireEvent.change(screen.getByLabelText("个人头像", { selector: "input" }), {
    target: { files: [file] },
  });
}
function avatarFile() {
  const file = new File(["gif"], "avatar.gif", { type: "image/gif" });
  Object.defineProperty(file, "arrayBuffer", {
    value: vi.fn(async () => new Uint8Array([103, 105, 102]).buffer),
  });
  return file;
}

test("personal avatar selection rejects empty and oversized files and cancellation restores the saved avatar", () => {
  render(<AvatarSettings />);
  select(new File([], "empty.png", { type: "image/png" }));
  expect(screen.getByRole("alert").textContent).toContain("头像为空");
  expect(
    screen.getByRole("button", { name: "保存头像" }).hasAttribute("disabled"),
  ).toBe(true);
  select(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png"));
  expect(
    screen
      .getAllByRole("alert")
      .some((alert) => alert.textContent?.includes("5 MiB")),
  ).toBe(true);
  select(avatarFile());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("img", { name: "avatar.gif" }).getAttribute("src"),
  ).toBe("blob:personal-avatar");
  expect(mocks.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消选择个人头像" }));
  expect(screen.getByText("已保存头像")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:personal-avatar");
  expect(
    screen.getByRole("button", { name: "保存头像" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("GIF upload keeps the checksum, revision and completion protocol and avatar removal refreshes the profile", async () => {
  const session = {
    id: "synthetic-session",
    url: "/synthetic-upload",
    headers: { "Content-Type": "image/gif" },
  };
  const updated = { ...mocks.user, revision: 8, avatarVersion: "new-avatar" };
  const removed = { ...mocks.user, revision: 9, avatarVersion: null };
  mocks.post
    .mockResolvedValueOnce({ data: session })
    .mockResolvedValueOnce({ data: updated });
  mocks.upload.mockResolvedValue(new Response());
  mocks.remove.mockResolvedValue({ data: removed });
  render(<AvatarSettings />);
  const file = avatarFile();
  select(file);
  fireEvent.click(screen.getByRole("button", { name: "保存头像" }));
  await screen.findByText("头像已更新");
  expect(crypto.subtle.digest).toHaveBeenCalledWith(
    "SHA-256",
    await file.arrayBuffer(),
  );
  expect(mocks.post).toHaveBeenNthCalledWith(
    1,
    "/api/users/me/avatar/upload-sessions",
    {
      body: {
        sourceName: "avatar.gif",
        contentType: "image/gif",
        size: 3,
        checksum: "000fff",
        expectedRevision: 7,
      },
    },
  );
  expect(mocks.upload).toHaveBeenCalledWith(session.url, {
    method: "PUT",
    headers: session.headers,
    body: file,
  });
  expect(mocks.post).toHaveBeenNthCalledWith(
    2,
    "/api/users/me/avatar/upload-sessions/{id}/complete",
    {
      params: { path: { id: session.id } },
      body: {},
    },
  );
  expect(mocks.refresh).toHaveBeenCalledWith(updated);
  expect(screen.queryByRole("img")).toBeNull();
  select(file);
  fireEvent.click(screen.getByRole("button", { name: "移除头像" }));
  await screen.findByText("头像已移除");
  expect(mocks.remove).toHaveBeenCalledWith("/api/users/me/avatar", {
    body: { expectedRevision: 7 },
  });
  expect(mocks.refresh).toHaveBeenCalledWith(removed);
  expect(screen.queryByRole("img")).toBeNull();
});

test("a failed avatar PUT keeps the local selection and never completes or refreshes the profile", async () => {
  mocks.post.mockResolvedValue({
    data: { id: "synthetic-session", url: "/synthetic-upload", headers: {} },
  });
  mocks.upload.mockResolvedValue(new Response(null, { status: 500 }));
  render(<AvatarSettings />);
  select(avatarFile());
  fireEvent.click(screen.getByRole("button", { name: "保存头像" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("头像上传失败"),
  );
  expect(screen.getByRole("img", { name: "avatar.gif" })).toBeTruthy();
  expect(mocks.post).toHaveBeenCalledOnce();
  expect(mocks.refresh).not.toHaveBeenCalled();
});
