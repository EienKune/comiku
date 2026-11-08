import { afterEach, expect, test } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { CandidateDraftLeaveGuard } from "./CandidateDraftLeaveGuard";
afterEach(cleanup);
test("router departure requires confirmation and cancellation preserves the page", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <CandidateDraftLeaveGuard dirty />
          <Link to="/next">离开</Link>
        </>
      ),
    },
    { path: "/next", element: <p>下一页</p> },
  ]);
  render(<RouterProvider router={router} />);
  fireEvent.click(screen.getByRole("link", { name: "离开" }));
  let dialog = await screen.findByRole("dialog");
  expect(document.activeElement).toBe(
    within(dialog).getByRole("button", { name: "继续编辑" }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "继续编辑" }));
  expect(router.state.location.pathname).toBe("/");
  fireEvent.click(screen.getByRole("link", { name: "离开" }));
  dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "放弃并离开" }));
  await screen.findByText("下一页");
  expect(router.state.location.pathname).toBe("/next");
});
