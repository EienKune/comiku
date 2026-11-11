import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { Badge, Button, TextField } from "../../components/ui";
import { client, unwrap } from "../account/api";
import "./source-credential-dialog.css";

type Maintenance = components["schemas"]["SourceMaintenanceDto"];
type Operation = components["schemas"]["SourceCredentialOperationDto"];
type Expected = components["schemas"]["SourceMaintenanceExpectedDto"];
export type CredentialIntent = Expected & { requestId: string };
type Props = {
  platform: "x" | "pixiv";
  recoveryIntent?: CredentialIntent;
  onIntentChange: (intent: CredentialIntent | null) => void;
  onClose: () => void;
};

const readonlyReasons: Record<string, string> = {
  not_enabled: "此部署未启用在线凭据维护。请联系部署管理员。",
  unsafe_path: "凭据文件不符合安全维护要求。请联系部署管理员。",
  invalid_configuration: "凭据配置不符合在线维护要求。请联系部署管理员。",
  unavailable: "在线凭据维护暂不可用。请联系部署管理员。",
};
const authLabels: Record<string, string> = {
  healthy: "认证状态正常",
  auth_paused: "认证暂停",
  cooling_down: "平台冷却中",
  unverified: "凭据待验证",
};
function expectation(state: Maintenance): Expected | null {
  return state.credentialGeneration
    ? {
        expectedEpoch: state.maintenanceEpoch,
        expectedGeneration: state.credentialGeneration,
      }
    : null;
}
function sameVersion(left: Expected, right: Expected | null) {
  return (
    !!right &&
    left.expectedEpoch === right.expectedEpoch &&
    left.expectedGeneration === right.expectedGeneration
  );
}
class ActionError extends Error {
  constructor(
    readonly status: number,
    readonly operationId?: string,
  ) {
    super("maintenance_action_failed");
  }
}
async function actionResult<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (!result.response.ok || result.data === undefined) {
    // Never display arbitrary response text next to a secret input.
    const error = result.error;
    const id =
      typeof error === "object" &&
      error !== null &&
      "operationId" in error &&
      typeof error.operationId === "string" &&
      /^[a-f0-9-]{36}$/i.test(error.operationId)
        ? error.operationId
        : undefined;
    if (result.response.status === 401) {
      try {
        await unwrap(result);
      } catch {
        /* unwrap invalidates the expired session. */
      }
    }
    throw new ActionError(result.response.status, id);
  }
  return result.data;
}

export function SourceCredentialDialog({
  platform,
  recoveryIntent,
  onIntentChange,
  onClose,
}: Props) {
  const queryClient = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const note = useId();
  const [visible, setVisible] = useState(() => !document.hidden);
  const [authToken, setAuthToken] = useState("");
  const [ct0, setCt0] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [unknown, setUnknown] = useState(!!recoveryIntent);
  const [receipt, setReceipt] = useState<Operation | null>(null);
  const receiptStatusAt = useRef(0);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const baseline = useRef<Expected | null>(recoveryIntent ?? null);
  const intent = useRef<CredentialIntent | null>(recoveryIntent ?? null);
  const mounted = useRef(true);
  const dirty = !!(authToken || ct0 || refreshToken);
  const status = useQuery({
    queryKey: ["source-maintenance", platform],
    enabled: visible,
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/source-fetch/platforms/{platform}/maintenance", {
          params: { path: { platform } },
          signal,
        }),
      ),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) =>
      visible && query.state.data?.maintenancePaused ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
  const state = status.data;
  const currentVersion = state ? expectation(state) : null;
  const serverOperation =
    state?.activeOperation ??
    (state?.lastOperation?.expectedEpoch === state?.maintenanceEpoch
      ? state?.lastOperation
      : null);
  // A delayed status read must never regress a confirmed terminal receipt.
  const keepTerminalReceipt =
    receipt?.expectedEpoch === state?.maintenanceEpoch &&
    ["activated", "aborted"].includes(receipt?.phase ?? "") &&
    (!serverOperation ||
      (serverOperation.id === receipt?.id &&
        (!["activated", "aborted"].includes(serverOperation.phase) ||
          (!!receipt?.verifiedAt &&
            (!serverOperation.verifiedAt ||
              receipt.verifiedAt >= serverOperation.verifiedAt)))));
  const operation =
    receipt &&
    (status.dataUpdatedAt <= receiptStatusAt.current || keepTerminalReceipt)
      ? receipt
      : serverOperation;
  const unresolved =
    !!operation && !["activated", "aborted"].includes(operation.phase);
  const matchedIntent =
    !!operation && operation.requestId === intent.current?.requestId;
  const outcomeUnknown =
    unknown &&
    !(matchedIntent && ["activated", "aborted"].includes(operation!.phase));
  const known = !!state && !status.isError && !status.isPending;
  const writable =
    known &&
    !permissionDenied &&
    state.supported &&
    !state.readonlyReason &&
    !!currentVersion;
  const stale =
    conflict ||
    (!!baseline.current &&
      dirty &&
      !sameVersion(baseline.current, currentVersion));
  const activated = operation?.phase === "activated";
  const canEdit =
    writable &&
    state.canSave &&
    !busy &&
    !outcomeUnknown &&
    !unresolved &&
    !activated;

  useEffect(() => {
    mounted.current = true;
    const prior = document.activeElement;
    const element = dialog.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element?.showModal();
    element?.querySelector<HTMLButtonElement>("button")?.focus();
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", visibility);
      document.body.style.overflow = overflow;
      element?.close();
      if (prior instanceof HTMLElement && prior.isConnected) prior.focus();
    };
  }, []);

  useEffect(() => {
    if (
      serverOperation?.requestId !== intent.current?.requestId ||
      !serverOperation ||
      !["activated", "aborted"].includes(serverOperation.phase)
    )
      return;
    intent.current = null;
    baseline.current = null;
    onIntentChange(null);
    setUnknown(false);
    setAuthToken("");
    setCt0("");
    setRefreshToken("");
  }, [serverOperation, onIntentChange]);

  function clearSecrets() {
    setAuthToken("");
    setCt0("");
    setRefreshToken("");
    baseline.current = null;
  }
  function close() {
    clearSecrets();
    onClose();
  }
  function acceptOperation(next: Operation) {
    receiptStatusAt.current = status.dataUpdatedAt;
    setReceipt(next);
    setReceiptId(next.id);
    if (["activated", "aborted"].includes(next.phase)) {
      setUnknown(false);
      intent.current = null;
      onIntentChange(null);
      clearSecrets();
    }
  }
  function failed(cause: unknown, saving = false) {
    if (
      cause instanceof ActionError &&
      [400, 401, 403, 409, 422].includes(cause.status) &&
      !cause.operationId
    ) {
      if (saving) {
        intent.current = null;
        onIntentChange(null);
        setUnknown(false);
      }
      if ([401, 403].includes(cause.status)) {
        setPermissionDenied(true);
        setError("当前账号无权执行此操作，请重新登录或检查权限。");
      } else if ([400, 422].includes(cause.status)) {
        setError("凭据格式未通过校验，请检查必填字段和长度。");
      } else {
        setConflict(true);
        setError(
          "维护状态或凭据版本已变化。输入已保留，请刷新状态后明确采用当前版本。",
        );
      }
    } else {
      if (saving || (cause instanceof ActionError && cause.operationId)) {
        setUnknown(true);
        if (cause instanceof ActionError && cause.operationId)
          setReceiptId(cause.operationId);
        setError(
          "更新结果尚未确认。请查询原操作，确认前不能再次替换凭据或恢复采集。",
        );
      } else setError("操作未确认，请刷新状态后重试。");
    }
  }
  async function changed() {
    await Promise.allSettled([
      queryClient.invalidateQueries({
        queryKey: ["source-maintenance", platform],
      }),
      queryClient.invalidateQueries({ queryKey: ["source-platforms"] }),
      queryClient.invalidateQueries({ queryKey: ["source-capabilities"] }),
    ]);
  }
  async function maintenanceAction(kind: "pause" | "resume") {
    if (!writable || !currentVersion || busy || outcomeUnknown || unresolved)
      return;
    const expected = currentVersion;
    setBusy(kind);
    setError("");
    try {
      const response =
        kind === "pause"
          ? await client.POST(
              "/api/source-fetch/platforms/{platform}/maintenance",
              { params: { path: { platform } }, body: expected },
            )
          : await client.POST("/api/source-fetch/platforms/{platform}/resume", {
              params: { path: { platform } },
              body: expected,
            });
      const next = await actionResult(response);
      queryClient.setQueryData(["source-maintenance", platform], next);
      if (mounted.current) {
        setReceipt(null);
        clearSecrets();
        setConflict(false);
      }
      await changed();
    } catch (cause) {
      if (mounted.current) failed(cause);
    } finally {
      if (mounted.current) setBusy("");
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canEdit || stale || !currentVersion || !dirty) return;
    const expected = baseline.current ?? currentVersion;
    const request: CredentialIntent = {
      ...expected,
      requestId: crypto.randomUUID(),
    };
    intent.current = request;
    onIntentChange(request);
    setBusy("save");
    setError("");
    try {
      const next = await actionResult(
        await client.POST(
          "/api/source-fetch/platforms/{platform}/credentials",
          {
            params: { path: { platform } },
            body: {
              ...request,
              ...(platform === "x" ? { authToken, ct0 } : { refreshToken }),
            },
          },
        ),
      );
      // Recovery intent must settle even when the dialog was closed during the request.
      if (["activated", "aborted"].includes(next.phase)) onIntentChange(null);
      if (mounted.current) acceptOperation(next);
      await changed();
    } catch (cause) {
      if (mounted.current) failed(cause, true);
    } finally {
      if (mounted.current) setBusy("");
    }
  }
  async function queryOriginal() {
    if (busy) return;
    setBusy("query");
    setError("");
    try {
      const latest = await status.refetch();
      if (latest.error) throw latest.error;
      const possible =
        latest.data?.activeOperation ?? latest.data?.lastOperation;
      const id =
        receiptId ??
        (intent.current
          ? possible?.requestId === intent.current.requestId
            ? possible.id
            : null
          : possible?.id);
      if (!id) {
        setError("尚未查到原更新记录，结果仍未知，请稍后再次查询。");
        return;
      }
      const next = await actionResult(
        await client.GET(
          "/api/source-fetch/platforms/{platform}/credential-updates/{id}",
          {
            params: { path: { platform, id } },
          },
        ),
      );
      if (mounted.current) acceptOperation(next);
    } catch {
      if (mounted.current)
        setError("原操作读取失败，结果仍未确认，请稍后重试。");
    } finally {
      if (mounted.current) setBusy("");
    }
  }
  async function operationAction(kind: "reconcile" | "verify" | "abort") {
    if (!operation || !writable || !currentVersion || busy) return;
    const id = operation.id;
    // A recovery uses the original epoch/generation, never a new update intent.
    const expected =
      kind === "verify"
        ? currentVersion
        : {
            expectedEpoch: operation.expectedEpoch,
            expectedGeneration: operation.expectedGeneration,
          };
    setBusy(kind);
    setError("");
    try {
      const options = { params: { path: { platform, id } }, body: expected };
      const response =
        kind === "reconcile"
          ? await client.POST(
              "/api/source-fetch/platforms/{platform}/credential-updates/{id}/reconcile",
              options,
            )
          : kind === "verify"
            ? await client.POST(
                "/api/source-fetch/platforms/{platform}/credential-updates/{id}/verify",
                options,
              )
            : await client.POST(
                "/api/source-fetch/platforms/{platform}/credential-updates/{id}/abort",
                options,
              );
      const next = await actionResult(response);
      if (mounted.current) acceptOperation(next);
      await changed();
    } catch (cause) {
      if (mounted.current) failed(cause);
    } finally {
      if (mounted.current) setBusy("");
    }
  }
  function edit(setter: (value: string) => void, value: string) {
    if (!baseline.current) baseline.current = currentVersion;
    setter(value);
  }
  async function adoptLatest() {
    const result = await status.refetch();
    if (result.data && !result.error) {
      baseline.current = expectation(result.data);
      setConflict(false);
      setError("");
    }
  }

  return (
    <dialog
      ref={dialog}
      className="source-credential-dialog"
      aria-labelledby={title}
      aria-describedby={note}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          close();
      }}
    >
      <header>
        <h2 id={title}>{platform === "x" ? "X" : "Pixiv"} 凭据管理</h2>
        <div className="source-credential-toolbar">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!!busy || !visible}
            loading={status.isFetching}
            onClick={() => void status.refetch()}
          >
            刷新状态
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            关闭
          </Button>
        </div>
      </header>
      <p id={note}>
        关闭窗口后仍保持平台当前维护状态。凭据只用于本次更新，不回显旧值。
      </p>
      {status.isPending && <p role="status">正在读取维护状态…</p>}
      {status.isError && (
        <p role="alert">维护状态读取失败，暂停所有修改。请刷新重试。</p>
      )}
      {state && (
        <>
          <div className="source-credential-state">
            <Badge tone={state.maintenancePaused ? "warning" : "neutral"}>
              {state.maintenancePaused ? "维护中" : "运行中"}
            </Badge>
            <span>{authLabels[state.authStatus] ?? "认证状态未知"}</span>
          </div>
          {state.cooldownUntil && (
            <p>
              平台冷却至{" "}
              <time dateTime={state.cooldownUntil}>
                {new Date(state.cooldownUntil).toLocaleString()}
              </time>
              ，更换凭据不会清除可信冷却。
            </p>
          )}
          {(!state.supported || state.readonlyReason) && (
            <p role="status">
              {readonlyReasons[state.readonlyReason ?? ""] ??
                "此部署不支持在线凭据维护。请联系部署管理员。"}
            </p>
          )}
          {state.maintenancePaused && state.unsettledExecutions > 0 && (
            <p role="status">
              正在等待 {state.unsettledExecutions}{" "}
              项执行结束。排队任务会保留，排空前不能保存凭据。
            </p>
          )}
          {state.maintenancePaused &&
            !state.canSave &&
            !state.unsettledExecutions &&
            !operation &&
            writable && (
              <p role="status">平台尚未确认排空，请刷新状态后再试。</p>
            )}
          {writable && !state.maintenancePaused && (
            <div className="source-credential-actions">
              <Button
                type="button"
                loading={busy === "pause"}
                disabled={!!busy || outcomeUnknown || unresolved}
                onClick={() => void maintenanceAction("pause")}
              >
                暂停平台
              </Button>
            </div>
          )}
          {state.maintenancePaused &&
            !activated &&
            state.supported &&
            !state.readonlyReason && (
              <form
                className="source-credential-form"
                onSubmit={(event) => void save(event)}
              >
                {platform === "x" ? (
                  <>
                    <TextField
                      label="auth_token"
                      type="password"
                      autoComplete="off"
                      maxLength={8192}
                      required
                      value={authToken}
                      disabled={!canEdit}
                      onChange={(event) =>
                        edit(setAuthToken, event.target.value)
                      }
                    />
                    <TextField
                      label="ct0"
                      type="password"
                      autoComplete="off"
                      maxLength={8192}
                      required
                      value={ct0}
                      disabled={!canEdit}
                      onChange={(event) => edit(setCt0, event.target.value)}
                    />
                  </>
                ) : (
                  <TextField
                    label="refresh_token"
                    type="password"
                    autoComplete="off"
                    maxLength={8192}
                    required
                    value={refreshToken}
                    disabled={!canEdit}
                    onChange={(event) =>
                      edit(setRefreshToken, event.target.value)
                    }
                  />
                )}
                {stale && (
                  <div className="source-credential-conflict" role="alert">
                    <p>
                      维护版本已变化，输入已保留。刷新并采用当前版本后再保存。
                    </p>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={!!busy || outcomeUnknown}
                      onClick={() => void adoptLatest()}
                    >
                      刷新并采用当前版本
                    </Button>
                  </div>
                )}
                <Button
                  type="submit"
                  loading={busy === "save"}
                  disabled={
                    !canEdit ||
                    stale ||
                    !(platform === "x" ? authToken && ct0 : refreshToken)
                  }
                >
                  保存凭据
                </Button>
              </form>
            )}
          {(unresolved || outcomeUnknown) && (
            <section
              className="source-credential-recovery"
              aria-label="更新恢复"
            >
              <p role="status">
                更新尚未确认。平台继续维护，请查询或继续原操作。
              </p>
              <div className="source-credential-actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!!busy}
                  onClick={() => void queryOriginal()}
                >
                  查询原操作
                </Button>
                {unresolved && (
                  <Button
                    type="button"
                    disabled={!writable || !!busy}
                    loading={busy === "reconcile"}
                    onClick={() => void operationAction("reconcile")}
                  >
                    继续原操作
                  </Button>
                )}
                {operation?.phase === "preparing" && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!writable || !!busy}
                    onClick={() => void operationAction("abort")}
                  >
                    取消未开始的更新
                  </Button>
                )}
              </div>
            </section>
          )}
          {activated && (
            <section
              className="source-credential-receipt"
              aria-label="更新回执"
            >
              <p role="status">
                {state.maintenancePaused
                  ? "凭据已更新，平台仍在维护中。"
                  : "凭据已更新。"}
              </p>
              <p>验证只检查认证路径，不扫描帖子或图片。</p>
              {operation?.verificationOutcome && (
                <p>
                  {operation.verificationOutcome === "passed"
                    ? "认证路径验证通过。"
                    : operation.verificationOutcome === "failed"
                      ? "认证路径验证失败，请检查凭据。"
                      : "认证路径验证结果不确定。"}
                </p>
              )}
              <Button
                type="button"
                variant="secondary"
                disabled={
                  !writable ||
                  !!busy ||
                  !!state.unsettledExecutions ||
                  !state.maintenancePaused
                }
                loading={busy === "verify"}
                onClick={() => void operationAction("verify")}
              >
                验证认证
              </Button>
            </section>
          )}
          {state.maintenancePaused && (
            <div className="source-credential-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={
                  !writable ||
                  !!busy ||
                  unresolved ||
                  outcomeUnknown ||
                  !!state.unsettledExecutions
                }
                loading={busy === "resume"}
                onClick={() => void maintenanceAction("resume")}
              >
                {activated ? "恢复采集" : "取消维护并恢复采集"}
              </Button>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="source-credential-error">
          {error}
        </p>
      )}
    </dialog>
  );
}
