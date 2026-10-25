import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button, IconButton, SelectField, TextField } from "./ui";

afterEach(cleanup);

test("select keeps its label separate from the linked hint", () => {
  render(
    <SelectField label="工作状态" hint="筛选显示范围">
      <option>翻译中</option>
    </SelectField>,
  );
  const select = screen.getByRole("combobox", { name: "工作状态" });
  expect(
    document.getElementById(select.getAttribute("aria-describedby")!)
      ?.textContent,
  ).toBe("筛选显示范围");
});

test("custom select exposes styled options and reports keyboard selection", () => {
  const onValueChange = vi.fn();
  render(
    <SelectField
      label="工作状态"
      defaultValue="translate"
      onValueChange={onValueChange}
    >
      <optgroup label="处理中">
        <option value="translate">翻译中</option>
        <option value="proofread">校对中</option>
      </optgroup>
    </SelectField>,
  );
  const select = screen.getByRole("combobox", { name: "工作状态" });
  fireEvent.keyDown(select, { key: "ArrowDown" });
  fireEvent.keyDown(select, { key: "ArrowDown" });
  fireEvent.keyDown(select, { key: "Enter" });
  expect(onValueChange).toHaveBeenCalledWith("proofread");
  expect(select.textContent).toContain("校对中");
});

test("field errors are associated with a uniquely labelled input", () => {
  render(
    <>
      <TextField label="新密码" error="至少 12 个字符" />
      <TextField label="显示名" hint="用于团队展示" />
    </>,
  );
  const password = screen.getByRole("textbox", { name: "新密码" });
  const name = screen.getByRole("textbox", { name: "显示名" });
  expect(password.id).not.toBe(name.id);
  expect(password.getAttribute("aria-invalid")).toBe("true");
  expect(
    document.getElementById(password.getAttribute("aria-describedby")!)
      ?.textContent,
  ).toBe("至少 12 个字符");
  expect(
    document.getElementById(name.getAttribute("aria-describedby")!)
      ?.textContent,
  ).toBe("用于团队展示");
});

test("loading blocks repeated button actions and restores the action when complete", () => {
  const onClick = vi.fn();
  const { rerender } = render(
    <Button loading onClick={onClick}>
      保存
    </Button>,
  );
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(onClick).not.toHaveBeenCalled();
  rerender(<Button onClick={onClick}>保存</Button>);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("icon button exposes its explicit accessible name", () => {
  render(
    <IconButton label="关闭">
      <span aria-hidden="true">×</span>
    </IconButton>,
  );
  expect(
    screen.getByRole("button", { name: "关闭" }).getAttribute("title"),
  ).toBe("关闭");
});
