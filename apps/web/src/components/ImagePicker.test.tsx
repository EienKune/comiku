import { StrictMode, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImagePicker } from "./ImagePicker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({
  multiple = false,
  disabled = false,
  avatar = false,
}: {
  multiple?: boolean;
  disabled?: boolean;
  avatar?: boolean;
}) {
  const [files, setFiles] = useState<File[]>([]);
  return (
    <ImagePicker
      label="测试图片"
      files={files}
      onChange={setFiles}
      multiple={multiple}
      disabled={disabled}
      maxFiles={multiple ? 10 : 1}
      maxFileSize={5 * 1024 * 1024}
      variant={avatar ? "avatar" : "default"}
      currentAvatar={avatar ? <span>合</span> : undefined}
    />
  );
}

test("image selection previews, replaces a single image, removes and can reselect the same file", () => {
  let serial = 0;
  const create = vi.fn(() => `blob:${++serial}`);
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }),
  );
  const { unmount } = render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  const input = screen.getByLabelText("测试图片") as HTMLInputElement;
  const first = new File(["first"], "头像.png", { type: "image/png" });
  const second = new File(["second"], "长文件名-avatar.webp", {
    type: "image/webp",
  });
  fireEvent.change(input, { target: { files: [first] } });
  expect(
    screen.getByRole("img", { name: "头像.png" }).getAttribute("src"),
  ).toMatch(/^blob:/);
  expect(input.value).toBe("");
  fireEvent.change(input, { target: { files: [second] } });
  expect(screen.queryByRole("img", { name: "头像.png" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "移除 长文件名-avatar.webp" }),
  );
  expect(screen.queryByRole("img")).toBeNull();
  fireEvent.change(input, { target: { files: [first] } });
  expect(screen.getByRole("img", { name: "头像.png" })).toBeTruthy();
  unmount();
  expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual(
    create.mock.results.map(({ value }) => value).sort(),
  );
});

test("avatar selection opens from the current avatar, stays local, and cancellation restores it", () => {
  const create = vi.fn(() => "blob:avatar");
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }),
  );
  render(<Harness avatar />);
  const trigger = screen.getByRole("button", { name: "更换测试图片" });
  const input = screen.getByLabelText("测试图片") as HTMLInputElement;
  const click = vi.spyOn(input, "click");
  trigger.focus();
  expect(document.activeElement).toBe(trigger);
  expect(trigger.textContent).toContain("合");
  fireEvent.click(trigger);
  expect(click).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { files: [] } });
  expect(screen.queryByRole("status")).toBeNull();
  const file = new File(["avatar"], "avatar.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  expect(
    screen.getByRole("img", { name: "avatar.png" }).getAttribute("src"),
  ).toBe("blob:avatar");
  expect(screen.getByRole("status").textContent).toContain("未保存");
  fireEvent.change(input, {
    target: { files: [new File(["gif"], "bad.gif")] },
  });
  expect(screen.getByRole("alert").textContent).toContain("PNG");
  expect(screen.getByRole("img", { name: "avatar.png" })).toBeTruthy();
  fireEvent.change(input, {
    target: {
      files: [new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png")],
    },
  });
  expect(screen.getByRole("alert").textContent).toContain("5 MiB");
  fireEvent.click(screen.getByRole("button", { name: "取消选择测试图片" }));
  expect(
    screen.getByRole("button", { name: "更换测试图片" }).textContent,
  ).toContain("合");
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(revoke).toHaveBeenCalledWith("blob:avatar");
  fireEvent.change(input, { target: { files: [file] } });
  expect(screen.getByRole("img", { name: "avatar.png" })).toBeTruthy();
  expect(input.value).toBe("");
});

test("a locked avatar cannot be replaced or cancelled", () => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:avatar"),
      revokeObjectURL: vi.fn(),
    }),
  );
  const onChange = vi.fn();
  render(
    <ImagePicker
      label="作者头像"
      variant="avatar"
      files={[new File(["x"], "x.png")]}
      onChange={onChange}
      disabled
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "更换作者头像" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen
      .getByRole("button", { name: "取消选择作者头像" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("作者头像"), {
    target: { files: [new File(["y"], "y.png")] },
  });
  fireEvent.click(screen.getByRole("button", { name: "取消选择作者头像" }));
  expect(onChange).not.toHaveBeenCalled();
});

test("multiple images append without duplicates and invalid selections preserve the current files", () => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    }),
  );
  render(<Harness multiple />);
  const input = screen.getByLabelText("测试图片");
  const first = new File(["one"], "one.jpg", {
    type: "image/jpeg",
    lastModified: 1,
  });
  const second = new File(["two"], "two.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [first] } });
  fireEvent.change(input, { target: { files: [first, second] } });
  expect(screen.getAllByRole("img")).toHaveLength(2);
  fireEvent.change(input, {
    target: { files: [new File(["gif"], "bad.gif", { type: "image/gif" })] },
  });
  expect(screen.getByRole("alert").textContent).toContain("PNG");
  expect(screen.getAllByRole("img")).toHaveLength(2);
  fireEvent.change(input, {
    target: {
      files: [
        new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", {
          type: "image/png",
        }),
      ],
    },
  });
  expect(screen.getByRole("alert").textContent).toContain("5 MiB");
});

test("disabled state prevents selection and removal while keeping explicit button names", () => {
  const onChange = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    }),
  );
  render(
    <ImagePicker
      label="测试图片"
      files={[new File(["x"], "x.png", { type: "image/png" })]}
      onChange={onChange}
      disabled
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "更换测试图片" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("测试图片"), {
    target: { files: [new File(["y"], "y.png", { type: "image/png" })] },
  });
  fireEvent.click(screen.getByRole("button", { name: "移除 x.png" }));
  expect(onChange).not.toHaveBeenCalled();
});

test("the labelled native button is focusable and opens its linked file input", () => {
  render(<Harness />);
  const button = screen.getByRole("button", { name: "选择测试图片" });
  const input = screen.getByLabelText("测试图片");
  const click = vi.spyOn(input, "click");
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  expect(click).toHaveBeenCalledOnce();
});
