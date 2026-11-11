import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { client } from "../account/api";
import {
  SourceCredentialDialog,
  type CredentialIntent,
} from "./SourceCredentialDialog";

type Maintenance = components["schemas"]["SourceMaintenanceDto"];
type Operation = components["schemas"]["SourceCredentialOperationDto"];
const generation = "a".repeat(64);
const nextGeneration = "b".repeat(64);
const operation: Operation = {
  id: "00000000-0000-4000-8000-000000000001",
  platform: "x",
  requestId: "00000000-0000-4000-8000-000000000002",
  phase: "activated",
  failureCode: null,
  expectedEpoch: 3,
  expectedGeneration: generation,
  targetGeneration: nextGeneration,
  verificationOutcome: null,
  verificationCode: null,
  verifiedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  completedAt: "2026-01-01T00:01:00Z",
};
const state = (extra: Partial<Maintenance> = {}): Maintenance => ({
  platform: "x",
  supported: true,
  readonlyReason: null,
  maintenancePaused: true,
  maintenanceEpoch: 3,
  credentialGeneration: generation,
  unsettledExecutions: 0,
  canSave: true,
  authStatus: "auth_paused",
  errorCode: "auth_failed",
  cooldownUntil: null,
  activeOperation: null,
  lastOperation: null,
  observedAt: "2026-01-01T00:00:00Z",
  ...extra,
});
function ok<T>(data: T) {
  return { data, response: new Response() };
}
function setup(initial = state(), recoveryIntent?: CredentialIntent) {
  let current = initial;
  const get = vi
    .spyOn(client, "GET")
    .mockImplementation(async () => ok(current) as never);
  const post = vi
    .spyOn(client, "POST")
    .mockImplementation(async () => ok(current) as never);
  const onClose = vi.fn();
  const onIntentChange = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SourceCredentialDialog
        platform="x"
        recoveryIntent={recoveryIntent}
        onClose={onClose}
        onIntentChange={onIntentChange}
      />
    </QueryClientProvider>,
  );
  return {
    get,
    post,
    onClose,
    onIntentChange,
    queryClient,
    ...view,
    setState(next: Maintenance) {
      current = next;
    },
  };
}
async function fill() {
  fireEvent.change(await screen.findByLabelText("auth_token"), {
    target: { value: "synthetic-private-auth" },
  });
  fireEvent.change(screen.getByLabelText("ct0"), {
    target: { value: "synthetic-private-ct0" },
  });
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("running platform groups refresh and close in the header, separate from maintenance actions", async () => {
  const { post } = setup(state({ maintenancePaused: false, canSave: false }));
  const pause = await screen.findByRole("button", { name: "暂停平台" });
  const dialog = screen.getByRole("dialog");
  const header = dialog.querySelector("header")!;
  expect(within(header).getByRole("button", { name: "刷新状态" })).toBeTruthy();
  expect(within(header).getByRole("button", { name: "关闭" })).toBeTruthy();
  expect(dialog.querySelector("footer")).toBeNull();
  expect(pause.closest(".source-credential-actions")).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
});

test("readonly maintenance shows a safe reason without credentials or mutating actions", async () => {
  const { post } = setup(
    state({
      supported: false,
      readonlyReason: "not_enabled",
      maintenancePaused: false,
    }),
  );
  expect(
    await screen.findByText("此部署未启用在线凭据维护。请联系部署管理员。"),
  ).toBeTruthy();
  expect(screen.queryByLabelText("auth_token")).toBeNull();
  expect(screen.queryByRole("button", { name: "暂停平台" })).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

test("permission failure hides every write action and refresh remains read-only", async () => {
  const { get, post } = setup();
  await screen.findByLabelText("auth_token");
  get.mockResolvedValue({
    error: { message: "forbidden" },
    response: new Response(null, { status: 403 }),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
  await screen.findByText("维护状态读取失败，暂停所有修改。请刷新重试。");
  expect(screen.queryByRole("button", { name: "暂停平台" })).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

test("draining executions disables saving and explicitly retains queued work", async () => {
  const { post } = setup(state({ unsettledExecutions: 2, canSave: false }));
  await screen.findByText(
    "正在等待 2 项执行结束。排队任务会保留，排空前不能保存凭据。",
  );
  expect(
    (screen.getByLabelText("auth_token") as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "取消维护并恢复采集",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(post).not.toHaveBeenCalled();
});

test("close restores focus and scrolling, never resumes or saves, and a new dialog has no secrets", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  document.body.style.overflow = "auto";
  const first = setup();
  await fill();
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(first.onClose).toHaveBeenCalledOnce();
  expect(first.post).not.toHaveBeenCalled();
  first.unmount();
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe("auto");
  const second = setup();
  expect(
    ((await screen.findByLabelText("auth_token")) as HTMLInputElement).value,
  ).toBe("");
  expect((screen.getByLabelText("ct0") as HTMLInputElement).type).toBe(
    "password",
  );
  second.unmount();
  opener.remove();
  document.body.style.overflow = "";
});

test("background refresh preserves drafts and the original epoch until explicit adoption", async () => {
  const fixture = setup();
  await fill();
  fixture.setState(state({ maintenanceEpoch: 4 }));
  await act(() =>
    fixture.queryClient.invalidateQueries({ queryKey: ["source-maintenance"] }),
  );
  await screen.findByRole("button", { name: "刷新并采用当前版本" });
  expect((screen.getByLabelText("auth_token") as HTMLInputElement).value).toBe(
    "synthetic-private-auth",
  );
  expect(
    (screen.getByRole("button", { name: "保存凭据" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "刷新并采用当前版本" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "保存凭据" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fixture.post.mockResolvedValue(
    ok({ ...operation, expectedEpoch: 4 }) as never,
  );
  fireEvent.click(screen.getByRole("button", { name: "保存凭据" }));
  await screen.findByText("凭据已更新，平台仍在维护中。");
  expect(fixture.post).toHaveBeenCalledWith(
    "/api/source-fetch/platforms/{platform}/credentials",
    expect.objectContaining({
      body: expect.objectContaining({
        expectedEpoch: 4,
        expectedGeneration: generation,
      }),
    }),
  );
});

test("a rejected stale save retains secrets and requires an explicit version refresh", async () => {
  const fixture = setup();
  await fill();
  fixture.post.mockResolvedValue({
    error: { message: "conflict" },
    response: new Response(null, { status: 409 }),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "保存凭据" }));
  await screen.findByRole("button", { name: "刷新并采用当前版本" });
  expect((screen.getByLabelText("auth_token") as HTMLInputElement).value).toBe(
    "synthetic-private-auth",
  );
  expect(fixture.onIntentChange.mock.lastCall?.[0]).toBeNull();
});

test("lost save response freezes the same intent, reads the receipt, and clears secrets only on confirmation", async () => {
  const fixture = setup();
  await fill();
  fixture.post.mockRejectedValue(new TypeError("synthetic network failure"));
  fireEvent.click(screen.getByRole("button", { name: "保存凭据" }));
  await screen.findByRole("button", { name: "查询原操作" });
  expect(
    (screen.getByLabelText("auth_token") as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "取消维护并恢复采集",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  const pending = fixture.onIntentChange.mock.calls[0][0] as CredentialIntent;
  const receipt = { ...operation, requestId: pending.requestId };
  fixture.setState(
    state({
      canSave: false,
      credentialGeneration: nextGeneration,
      lastOperation: receipt,
    }),
  );
  fixture.get.mockImplementation(
    async (path) =>
      ok(
        path ===
          "/api/source-fetch/platforms/{platform}/credential-updates/{id}"
          ? receipt
          : state({
              canSave: false,
              credentialGeneration: nextGeneration,
              lastOperation: receipt,
            }),
      ) as never,
  );
  fireEvent.click(screen.getByRole("button", { name: "查询原操作" }));
  await screen.findByText("凭据已更新，平台仍在维护中。");
  expect(fixture.post).toHaveBeenCalledOnce();
  expect(fixture.onIntentChange.mock.lastCall?.[0]).toBeNull();
  expect(screen.queryByDisplayValue("synthetic-private-auth")).toBeNull();
});

test.each(["prepared", "blocked"])(
  "%s recovery only continues the original operation and cannot abort",
  async (phase) => {
    const fixture = setup(
      state({
        activeOperation: { ...operation, phase, completedAt: null },
        canSave: false,
      }),
    );
    await screen.findByRole("button", { name: "继续原操作" });
    expect(
      screen.queryByRole("button", { name: "取消未开始的更新" }),
    ).toBeNull();
    fixture.post.mockResolvedValue(ok(operation) as never);
    fireEvent.click(screen.getByRole("button", { name: "继续原操作" }));
    await screen.findByText("凭据已更新，平台仍在维护中。");
    expect(fixture.post.mock.calls[0]).toMatchObject([
      "/api/source-fetch/platforms/{platform}/credential-updates/{id}/reconcile",
      {
        params: { path: { platform: "x", id: operation.id } },
        body: { expectedEpoch: 3, expectedGeneration: generation },
      },
    ]);
  },
);

test("activated receipt on reopen separates bounded verification from explicit resume", async () => {
  const fixture = setup(
    state({
      credentialGeneration: nextGeneration,
      canSave: false,
      lastOperation: operation,
    }),
  );
  await screen.findByText("验证只检查认证路径，不扫描帖子或图片。");
  expect(fixture.post).not.toHaveBeenCalled();
  fixture.post.mockResolvedValue(
    ok({
      ...operation,
      verificationOutcome: "passed",
      verifiedAt: "2026-01-01T00:02:00Z",
    }) as never,
  );
  fireEvent.click(screen.getByRole("button", { name: "验证认证" }));
  await screen.findByText("认证路径验证通过。");
  expect(fixture.post.mock.calls[0][0]).toBe(
    "/api/source-fetch/platforms/{platform}/credential-updates/{id}/verify",
  );
  expect(fixture.post).toHaveBeenCalledWith(
    "/api/source-fetch/platforms/{platform}/credential-updates/{id}/verify",
    expect.objectContaining({
      body: { expectedEpoch: 3, expectedGeneration: nextGeneration },
    }),
  );
  expect(fixture.post).toHaveBeenCalledOnce();
});

test("unresolved intent reopened before its record appears never creates another update", async () => {
  const pending = {
    requestId: operation.requestId,
    expectedEpoch: 3,
    expectedGeneration: generation,
  };
  const fixture = setup(state(), pending);
  await screen.findByRole("button", { name: "查询原操作" });
  fireEvent.click(screen.getByRole("button", { name: "查询原操作" }));
  await screen.findByText("尚未查到原更新记录，结果仍未知，请稍后再次查询。");
  expect(fixture.post).not.toHaveBeenCalled();
  expect(fixture.onIntentChange).not.toHaveBeenCalled();
});

test("maintenance polling stops while the document is hidden", async () => {
  const fixture = setup();
  await screen.findByLabelText("auth_token");
  vi.useFakeTimers();
  const count = fixture.get.mock.calls.length;
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(fixture.get).toHaveBeenCalledTimes(count);
});

test("only an explicit pause uses the observed version and no form is offered while running", async () => {
  const fixture = setup(state({ maintenancePaused: false, canSave: false }));
  await screen.findByRole("button", { name: "暂停平台" });
  expect(screen.queryByLabelText("auth_token")).toBeNull();
  expect(fixture.post).not.toHaveBeenCalled();
  fixture.setState(state());
  fixture.post.mockResolvedValue(ok(state()) as never);
  fireEvent.click(screen.getByRole("button", { name: "暂停平台" }));
  await screen.findByLabelText("auth_token");
  expect(fixture.post).toHaveBeenCalledWith(
    "/api/source-fetch/platforms/{platform}/maintenance",
    {
      params: { path: { platform: "x" } },
      body: { expectedEpoch: 3, expectedGeneration: generation },
    },
  );
});

test("preparing permits only a controlled abort, preserving maintenance afterward", async () => {
  const fixture = setup(
    state({
      canSave: false,
      activeOperation: { ...operation, phase: "preparing", completedAt: null },
    }),
  );
  await screen.findByRole("button", { name: "取消未开始的更新" });
  const aborted = { ...operation, phase: "aborted" };
  fixture.setState(state({ lastOperation: aborted }));
  fixture.post.mockResolvedValue(ok(aborted) as never);
  fireEvent.click(screen.getByRole("button", { name: "取消未开始的更新" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "继续原操作" })).toBeNull(),
  );
  expect(fixture.post).toHaveBeenCalledWith(
    "/api/source-fetch/platforms/{platform}/credential-updates/{id}/abort",
    {
      params: { path: { platform: "x", id: operation.id } },
      body: { expectedEpoch: 3, expectedGeneration: generation },
    },
  );
  expect(screen.getByText("维护中")).toBeTruthy();
  expect(fixture.post).toHaveBeenCalledOnce();
});

test("secrets never enter storage, navigation, or logging", async () => {
  const store = vi.spyOn(Storage.prototype, "setItem");
  const navigate = vi.spyOn(history, "replaceState");
  const log = vi.spyOn(console, "log");
  const warn = vi.spyOn(console, "warn");
  const error = vi.spyOn(console, "error");
  const fixture = setup();
  await fill();
  fixture.post.mockResolvedValue(ok(operation) as never);
  fireEvent.click(screen.getByRole("button", { name: "保存凭据" }));
  await screen.findByText("凭据已更新，平台仍在维护中。");
  expect(store).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(location.href).not.toContain("synthetic-private");
});

test("losing permission on save locks mutation controls until the dialog is reopened", async () => {
  const fixture = setup();
  await fill();
  fixture.post.mockResolvedValue({
    error: { message: "forbidden" },
    response: new Response(null, { status: 403 }),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "保存凭据" }));
  await screen.findByText("当前账号无权执行此操作，请重新登录或检查权限。");
  expect(
    (screen.getByRole("button", { name: "保存凭据" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "取消维护并恢复采集",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("an interior dialog click preserves the draft; Escape only closes", async () => {
  const fixture = setup();
  await fill();
  const modal = screen.getByRole("dialog");
  vi.spyOn(modal, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 10,
    width: 300,
    height: 500,
    left: 10,
    top: 10,
    right: 310,
    bottom: 510,
    toJSON() {
      return {};
    },
  });
  fireEvent.click(modal, { clientX: 100, clientY: 100 });
  expect(fixture.onClose).not.toHaveBeenCalled();
  fireEvent(modal, new Event("cancel", { cancelable: true }));
  expect(fixture.onClose).toHaveBeenCalledOnce();
  expect(fixture.post).not.toHaveBeenCalled();
});

test("invalid credential input keeps the draft without claiming a version conflict", async () => {
  const fixture = setup();
  await fill();
  fixture.post.mockResolvedValue({
    error: { message: "invalid synthetic field" },
    response: new Response(null, { status: 400 }),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "保存凭据" }));
  await screen.findByText("凭据格式未通过校验，请检查必填字段和长度。");
  expect(
    screen.queryByRole("button", { name: "刷新并采用当前版本" }),
  ).toBeNull();
  expect((screen.getByLabelText("auth_token") as HTMLInputElement).value).toBe(
    "synthetic-private-auth",
  );
});
