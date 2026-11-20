import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { components, CurrentUser } from "@comiku/api-client";
import { client, queryClient } from "../account/api";
import { AddProofreader } from "./AddProofreader";

const state = vi.hoisted(() => ({ user: null as CurrentUser | null }));
vi.mock("../account/account-context", () => ({ useAccount: () => state.user }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  queryClient.clear();
});

type Work = components["schemas"]["WorkDetailDto"];
const actor = (
  roles: CurrentUser["roles"],
  languages: CurrentUser["languageCapabilities"] = ["ja"],
) =>
  ({
    id: "self",
    roles,
    languageCapabilities: languages,
    permissions: roles.includes("admin") ? ["works:admin"] : [],
  }) as unknown as CurrentUser;
function show(
  user: CurrentUser,
  work = {
    id: "work",
    revision: 7,
    sourceLanguage: "ja",
    collaborationMode: "multi",
    workflowStatus: "proofreading",
    reviewStatus: "normal",
    participants: [{ userId: "first", stage: "proofread", leftAt: null }],
  } as Work,
) {
  state.user = user;
  const members = [
    { ...user, displayName: "本人" },
    {
      id: "first",
      displayName: "首校",
      roles: ["proofreader"],
      languageCapabilities: ["ja"],
    },
    {
      id: "eligible",
      displayName: "合格校对",
      roles: ["proofreader"],
      languageCapabilities: ["ja"],
    },
    {
      id: "admin",
      displayName: "仅管理员",
      roles: ["admin"],
      languageCapabilities: ["ja"],
    },
    {
      id: "wrong",
      displayName: "语种不符",
      roles: ["proofreader"],
      languageCapabilities: ["ko"],
    },
  ];
  vi.spyOn(client, "GET").mockResolvedValue({
    data: members,
    response: new Response(null, { status: 200 }),
  } as never);
  const updated = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <AddProofreader work={work} onUpdated={updated} />
    </QueryClientProvider>,
  );
  return { work, updated };
}

test("a qualified administrator joins existing proofreading through the add endpoint and is omitted from the member picker", async () => {
  queryClient.setQueryData(["translation-editor", "work"], { canEdit: false });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const response = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: "work", revision: 8 }), {
      status: 200,
    }),
  );
  vi.stubGlobal("fetch", response);
  const { updated } = show(actor(["admin", "translator", "proofreader"]));
  fireEvent.click(screen.getByRole("button", { name: "加入校对" }));
  await waitFor(() =>
    expect(updated).toHaveBeenCalledWith({ id: "work", revision: 8 }),
  );
  expect(response).toHaveBeenCalledWith(
    "/api/works/work/stages/proofreaders",
    expect.objectContaining({ method: "POST", body: expect.any(String) }),
  );
  expect(JSON.parse(response.mock.calls[0][1].body)).toMatchObject({
    userId: "self",
    expectedRevision: 7,
  });
  expect(
    queryClient.getQueryData(["translation-editor", "work"]),
  ).toBeUndefined();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["works"] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard-works"] });
  fireEvent.click(screen.getByRole("button", { name: "添加校对" }));
  const picker = await screen.findByRole("combobox", { name: "选择校对成员" });
  fireEvent.click(picker);
  expect(
    within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["选择校对成员", "合格校对"]);
});

test.each([
  { roles: ["admin", "translator", "typesetter"] },
  { roles: ["admin", "proofreader"] },
] as { roles: CurrentUser["roles"] }[])(
  "administrator qualification still requires the proofreading role and source language: $roles",
  async ({ roles }) => {
    show(actor(roles, roles.includes("proofreader") ? ["ko"] : ["ja"]));
    expect(screen.queryByRole("button", { name: "加入校对" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "添加校对" }));
    const picker = await screen.findByRole("combobox", {
      name: "选择校对成员",
    });
    fireEvent.click(picker);
    expect(
      within(screen.getByRole("listbox")).queryByRole("option", {
        name: "本人",
      }),
    ).toBeNull();
  },
);

test("a qualified ordinary outsider cannot add themselves or others", () => {
  show(actor(["translator", "proofreader"]));
  expect(screen.queryByRole("button", { name: "加入校对" })).toBeNull();
  expect(screen.queryByRole("button", { name: "添加校对" })).toBeNull();
});

test.each([
  "pending_typeset",
  "pending_publish",
  "published",
  "archived",
] as const)(
  "proofread additions are hidden after the proofreading claim window: %s",
  (workflowStatus) => {
    show(actor(["admin", "proofreader"]), {
      id: "work",
      sourceLanguage: "ja",
      collaborationMode: "multi",
      workflowStatus,
      reviewStatus: "normal",
      participants: [],
    } as unknown as Work);
    expect(screen.queryByRole("button", { name: "添加校对" })).toBeNull();
  },
);

test("a current qualified proofreader can add colleagues without a self-join action", () => {
  show(actor(["proofreader"]), {
    id: "work",
    sourceLanguage: "ja",
    collaborationMode: "multi",
    workflowStatus: "proofreading",
    reviewStatus: "normal",
    participants: [{ stage: "proofread", userId: "self", leftAt: null }],
  } as unknown as Work);
  expect(screen.getByRole("button", { name: "添加校对" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "加入校对" })).toBeNull();
});
