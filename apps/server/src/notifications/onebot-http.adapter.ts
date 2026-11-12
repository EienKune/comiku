import { lookup as dnsLookup } from "node:dns/promises";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupAddress } from "node:dns";
import type {
  NotificationSendResult,
  ValidatedNotificationConnection,
} from "./notifications.contracts.js";
import {
  isForbiddenNotificationIp,
  isPrivateNotificationIp,
  normalizeNotificationIp,
} from "./notification-connections.js";
import {
  NOTIFICATION_MESSAGE_PAYLOAD_MAX_BYTES,
  notificationMessageSegments,
  notificationMessageTextValid,
  type NotificationMessagePolicy,
} from "./notification-message-segments.js";

export interface OneBotHttpAdapterOptions {
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  timeoutMs?: number;
}

export class OneBotHttpAdapter {
  private readonly agents = new Map<string, HttpAgent | HttpsAgent>();
  private readonly lookup: (hostname: string) => Promise<LookupAddress[]>;
  private readonly timeoutMs: number;
  constructor(options: OneBotHttpAdapterOptions = {}) {
    this.lookup =
      options.lookup ??
      ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
    this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? 5000, 1), 5000);
  }

  /** Node's native HTTP clients deliberately ignore HTTP(S)_PROXY and never follow redirects. */
  async send(
    connection: ValidatedNotificationConnection,
    groupId: string,
    text: string,
    signal?: AbortSignal,
    frozenSegments?: unknown,
    policy: NotificationMessagePolicy = "standard",
  ): Promise<NotificationSendResult> {
    const segments =
      frozenSegments == null
        ? [{ type: "text", data: { text } }]
        : notificationMessageSegments(frozenSegments, policy);
    if (
      !/^[1-9]\d{0,19}$/.test(groupId) ||
      !notificationMessageTextValid(text, policy) ||
      !segments ||
      (policy === "work_digest" && frozenSegments == null)
    ) {
      return {
        status: "failed",
        errorCode: "notification_payload_invalid",
        sendBoundaryCrossed: false,
      };
    }
    if (policy === "work_digest") {
      let offset = 0;
      for (const segment of segments) {
        if (segment.type !== "text") continue;
        if (!text.startsWith(segment.data.text, offset))
          return {
            status: "failed",
            errorCode: "notification_payload_invalid",
            sendBoundaryCrossed: false,
          };
        offset += segment.data.text.length;
      }
      if (offset !== text.length)
        return {
          status: "failed",
          errorCode: "notification_payload_invalid",
          sendBoundaryCrossed: false,
        };
    }
    const payload = JSON.stringify({
      group_id: groupId,
      message: segments,
      auto_escape: true,
    });
    if (Buffer.byteLength(payload) > NOTIFICATION_MESSAGE_PAYLOAD_MAX_BYTES)
      return {
        status: "failed",
        errorCode: "notification_payload_invalid",
        sendBoundaryCrossed: false,
      };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, this.timeoutMs);
    let boundary = false;
    const fail = (
      status: NotificationSendResult["status"],
      errorCode: string,
    ): NotificationSendResult => ({
      status,
      errorCode,
      sendBoundaryCrossed: boundary,
    });
    try {
      const endpoint = new URL(connection.endpoint);
      const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
      // DNS itself must share the total deadline; abort must not create a later request.
      const addresses = await Promise.race([
        isIP(hostname)
          ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
          : this.lookup(hostname),
        new Promise<never>((_, reject) => {
          if (controller.signal.aborted)
            reject(new Error("notification_aborted"));
          else
            controller.signal.addEventListener(
              "abort",
              () => reject(new Error("notification_aborted")),
              { once: true },
            );
        }),
      ]);
      if (controller.signal.aborted)
        return fail("retryable", "notification_request_not_sent");
      if (
        !addresses.length ||
        addresses.some(({ address }) => {
          const ip = normalizeNotificationIp(address);
          return (
            isForbiddenNotificationIp(ip) ||
            !connection.allowedIps.includes(ip) ||
            (endpoint.protocol === "http:" && !isPrivateNotificationIp(ip))
          );
        })
      )
        return fail("failed", "notification_destination_rejected");
      const pinned = normalizeNotificationIp(addresses[0]!.address);
      let agent = this.agents.get(connection.fingerprint);
      if (!agent) {
        if (this.agents.size >= 8) {
          const oldest = this.agents.entries().next().value;
          if (oldest) {
            oldest[1].destroy();
            this.agents.delete(oldest[0]);
          }
        }
        const options = {
          keepAlive: true,
          maxSockets: 1,
          maxFreeSockets: 1,
          maxTotalSockets: 1,
          timeout: 5000,
        };
        agent =
          endpoint.protocol === "https:"
            ? new HttpsAgent({ ...options, rejectUnauthorized: true })
            : new HttpAgent(options);
        this.agents.set(connection.fingerprint, agent);
      }
      return await new Promise<NotificationSendResult>((resolve) => {
        let settled = false;
        const finish = (result: NotificationSendResult) => {
          if (!settled) {
            settled = true;
            resolve(result);
          }
        };
        const request = (
          endpoint.protocol === "https:" ? httpsRequest : httpRequest
        )(
          {
            protocol: endpoint.protocol,
            hostname,
            port: endpoint.port || undefined,
            path: "/send_group_msg",
            method: "POST",
            agent,
            signal: controller.signal,
            // Keep hostname/SNI/certificate identity original while replacing resolution with the validated IP.
            lookup: ((
              _host: string,
              options: { all?: boolean },
              callback: (...args: unknown[]) => void,
            ) => {
              if (options.all)
                callback(null, [{ address: pinned, family: isIP(pinned) }]);
              else callback(null, pinned, isIP(pinned));
            }) as never,
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
              authorization: `Bearer ${connection.token}`,
            },
          },
          (response) => {
            boundary = true;
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 65_536) {
                finish(fail("unknown", "notification_response_too_large"));
                response.destroy();
              } else chunks.push(chunk);
            });
            response.on("error", () =>
              finish(fail("unknown", "notification_response_incomplete")),
            );
            response.on("aborted", () =>
              finish(fail("unknown", "notification_response_incomplete")),
            );
            response.on("end", () => {
              if (settled) return;
              if (response.statusCode === 401 || response.statusCode === 403)
                return finish(fail("failed", "notification_provider_rejected"));
              if (response.statusCode !== 200)
                return finish(fail("unknown", "notification_http_unconfirmed"));
              try {
                const body: unknown = JSON.parse(
                  Buffer.concat(chunks).toString("utf8"),
                );
                if (!body || typeof body !== "object")
                  return finish(
                    fail("unknown", "notification_receipt_invalid"),
                  );
                const reply = body as {
                  status?: unknown;
                  retcode?: unknown;
                  data?: { message_id?: unknown };
                };
                const messageId = reply.data?.message_id;
                if (
                  reply.status === "ok" &&
                  reply.retcode === 0 &&
                  ((typeof messageId === "number" &&
                    Number.isSafeInteger(messageId) &&
                    messageId !== 0) ||
                    (typeof messageId === "string" &&
                      /^-?[1-9]\d{0,19}$/.test(messageId)))
                ) {
                  return finish({
                    status: "accepted",
                    providerMessageId: String(messageId),
                    sendBoundaryCrossed: true,
                  });
                }
                if (
                  reply.status === "failed" &&
                  [100, 1400, 1401, 1404].includes(reply.retcode as number)
                )
                  return finish(
                    fail("failed", "notification_provider_rejected"),
                  );
                finish(fail("unknown", "notification_receipt_unconfirmed"));
              } catch {
                finish(fail("unknown", "notification_receipt_invalid"));
              }
            });
          },
        );
        request.on("socket", (socket) => {
          // Reused sockets are already connected; once connected a lost response cannot prove no send.
          if (!socket.connecting) boundary = true;
          else
            socket.once(
              endpoint.protocol === "https:" ? "secureConnect" : "connect",
              () => {
                boundary = true;
              },
            );
        });
        request.on("error", (error) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            !boundary &&
            [
              "ECONNREFUSED",
              "ENETUNREACH",
              "EHOSTUNREACH",
              "ENOTFOUND",
              "EAI_AGAIN",
            ].includes(code ?? "")
          ) {
            finish(fail("retryable", "notification_connect_failed"));
          } else if (
            !boundary &&
            [
              "CERT_HAS_EXPIRED",
              "DEPTH_ZERO_SELF_SIGNED_CERT",
              "ERR_TLS_CERT_ALTNAME_INVALID",
              "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            ].includes(code ?? "")
          ) {
            finish(fail("failed", "notification_tls_rejected"));
          } else
            finish(
              fail(
                boundary ? "unknown" : "retryable",
                boundary
                  ? "notification_send_unconfirmed"
                  : "notification_request_not_sent",
              ),
            );
        });
        request.end(payload);
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        ["ENOTFOUND", "EAI_AGAIN"].includes(code ?? "") ||
        controller.signal.aborted
      )
        return fail("retryable", "notification_request_not_sent");
      return fail("failed", "notification_destination_rejected");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  close(): void {
    for (const agent of this.agents.values()) agent.destroy();
    this.agents.clear();
  }
}
