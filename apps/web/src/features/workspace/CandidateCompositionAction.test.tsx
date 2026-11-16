import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { CandidateCompositionAction } from "./CandidateCompositionAction";

afterEach(cleanup);

function hover(element: HTMLElement, pointerType = "mouse") {
  const event = new Event("pointerover", { bubbles: true });
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    buttons: { value: 0 },
  });
  fireEvent(element, event);
}

test("disabled reasons escape the scrolling topbar without activating the action", () => {
  const onClick = vi.fn();
  const view = render(
    <div className="workspace-topbar-context">
      <CandidateCompositionAction
        label="合并入库"
        reason="所选帖子作者不同，无法合并"
        onClick={onClick}
      />
    </div>,
  );
  const button = screen.getByRole("button", {
    name: "合并入库",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.queryByRole("tooltip")).toBeNull();
  hover(button);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip.textContent).toBe("所选帖子作者不同，无法合并");
  expect(tooltip.parentElement).toBe(document.body);
  expect(within(view.container).queryByRole("tooltip")).toBeNull();
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
  fireEvent.pointerOut(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("keyboard focus explains a disabled action and Escape, scroll and blur dismiss it", () => {
  render(
    <CandidateCompositionAction
      label="拆分入库"
      reason="拆分入库一次只处理 1 个帖子"
      onClick={() => {}}
    />,
  );
  const wrapper = screen.getByRole("button", {
    name: "拆分入库",
  }).parentElement!;
  expect(wrapper.tabIndex).toBe(0);
  fireEvent.focus(wrapper);
  expect(wrapper.getAttribute("aria-describedby")).toBe(
    screen.getByRole("tooltip").id,
  );
  fireEvent.keyDown(wrapper, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.blur(wrapper);
  fireEvent.focus(wrapper);
  fireEvent.scroll(window);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.blur(wrapper);
  fireEvent.focus(wrapper);
  fireEvent.blur(wrapper);
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("updated reasons stay current and enabling removes the old tooltip and wrapper", () => {
  const onClick = vi.fn();
  const view = render(
    <CandidateCompositionAction
      label="合并入库"
      reason="至少选择 2 个帖子"
      onClick={onClick}
    />,
  );
  hover(screen.getByRole("button", { name: "合并入库" }), "touch");
  expect(screen.queryByRole("tooltip")).toBeNull();
  hover(screen.getByRole("button", { name: "合并入库" }));
  view.rerender(
    <CandidateCompositionAction
      label="合并入库"
      reason="所选帖子作者不同，无法合并"
      onClick={onClick}
    />,
  );
  expect(screen.getByRole("tooltip").textContent).toBe(
    "所选帖子作者不同，无法合并",
  );
  view.rerender(
    <CandidateCompositionAction label="合并入库" reason="" onClick={onClick} />,
  );
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(
    view.container.querySelector(".candidate-composition-disabled-action"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "合并入库" }));
  expect(onClick).toHaveBeenCalledTimes(1);
});
