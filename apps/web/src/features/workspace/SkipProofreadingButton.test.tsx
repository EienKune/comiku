// @vitest-environment jsdom
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { client, queryClient } from "../account/api";
import { SkipProofreadingButton } from "./SkipProofreadingButton";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  queryClient.clear();
});

function fixture() {
  return {
    id: "work-id",
    revision: 12,
    editorEpoch: 4,
    canSkipProofreading: true,
    skipProofreadingUnavailableReason: null,
    proofreadingSkipped: false,
    participants: [
      {
        id: "claim-id",
        userId: "proof-user",
        displayName: "已认领成员",
        stage: "proofread",
        submittedAt: null,
        leftAt: null,
      },
    ],
    workflowStatus: "pending_proofread",
  };
}

test("reviews the current claim set, preserves normal flow on cancel and locks background scrolling", async () => {
  vi.spyOn(client, "GET").mockImplementation(
    async () =>
      ({
        data: fixture(),
        response: new Response(null, { status: 200 }),
      }) as never,
  );
  const post = vi.spyOn(client, "POST");
  render(<SkipProofreadingButton workId="work-id" available />);
  fireEvent.click(screen.getByRole("button", { name: "跳过校对" }));
  await screen.findByRole("dialog");
  expect(screen.getByText(/已认领成员/)).toBeTruthy();
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.click(screen.getByRole("button", { name: "保留校对流程" }));
  expect(post).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.style.overflow).toBe("");
});

test("explicit confirmation sends only reviewed claims and reuses the key after a network failure", async () => {
  const work = fixture();
  vi.spyOn(client, "GET").mockImplementation(
    async () =>
      ({ data: work, response: new Response(null, { status: 200 }) }) as never,
  );
  const post = vi
    .spyOn(client, "POST")
    .mockImplementationOnce(async () => {
      throw new Error("暂时断网");
    })
    .mockImplementationOnce(
      async () =>
        ({
          data: {
            ...work,
            proofreadingSkipped: true,
            workflowStatus: "pending_typeset",
          },
          response: new Response(null, { status: 200 }),
        }) as never,
    );
  const onSkipped = vi.fn();
  render(
    <SkipProofreadingButton workId="work-id" available onSkipped={onSkipped} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "跳过校对" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "取消认领并跳过校对" }),
  );
  await screen.findByText("暂时断网");
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "取消认领并跳过校对" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "取消认领并跳过校对" }));
  await waitFor(() => expect(onSkipped).toHaveBeenCalledOnce());
  const calls = post.mock.calls as unknown as [string, { body: unknown }][];
  const first = calls[0][1].body as {
    expectedRevision: number;
    expectedEditorEpoch: number;
    confirmCancelClaims: boolean;
    proofreadParticipantIds: string[];
    idempotencyKey: string;
  };
  expect(first).toMatchObject({
    expectedRevision: 12,
    expectedEditorEpoch: 4,
    confirmCancelClaims: true,
    proofreadParticipantIds: ["claim-id"],
  });
  expect(calls[1][1].body).toEqual(first);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(queryClient.getQueryData(["work", "work-id"])).toMatchObject({
    proofreadingSkipped: true,
  });
});
