import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { client } from "../account/api";
import { AuthorTagPicker, type AuthorTagChoice } from "./AuthorTagPicker";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function setup(initial: AuthorTagChoice[] = []) {
  const changed = vi.fn();
  function Form() {
    const [value, setValue] = useState(initial);
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          changed("submitted");
        }}
      >
        <AuthorTagPicker
          value={value}
          onChange={(next) => {
            setValue(next);
            changed(next);
          }}
        />
      </form>
    );
  }
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Form />
    </QueryClientProvider>,
  );
  return changed;
}
test("one Enter adds one chip and preserves commas inside a tag name", async () => {
  vi.spyOn(client, "GET").mockResolvedValue({
    data: [],
    response: new Response(),
  } as never);
  const changed = setup();
  const input = screen.getByRole("combobox", { name: "标签" });
  fireEvent.change(input, { target: { value: "手绘,彩色" } });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "添加" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.keyDown(input, { key: "Enter" });
  expect(changed).toHaveBeenLastCalledWith([{ name: "手绘,彩色" }]);
  expect(
    screen.getByRole("button", { name: "移除标签 手绘,彩色" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "移除标签 手绘,彩色" }));
  expect(changed).toHaveBeenLastCalledWith([]);
});
test("catalog choices retain ID/revision and typing does not refetch the catalog", async () => {
  const get = vi.spyOn(client, "GET").mockResolvedValue({
    data: [{ id: "existing", name: "已有标签", revision: 4 }],
    response: new Response(),
  } as never);
  const changed = setup();
  const input = screen.getByRole("combobox", { name: "标签" });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "已" } });
  fireEvent.click(await screen.findByRole("option", { name: "已有标签" }));
  expect(changed).toHaveBeenLastCalledWith([
    { id: "existing", name: "已有标签", revision: 4 },
  ]);
  fireEvent.change(input, { target: { value: "新" } });
  fireEvent.change(input, { target: { value: "新标签" } });
  await waitFor(() => expect(get).toHaveBeenCalledOnce());
});
test("IME confirmation neither adds a chip nor submits the author form", async () => {
  vi.spyOn(client, "GET").mockResolvedValue({
    data: [],
    response: new Response(),
  } as never);
  const changed = setup();
  const input = screen.getByRole("combobox", { name: "标签" });
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "标签" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(changed).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "添加" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(changed).toHaveBeenCalledOnce();
});
test("normalized duplicates do not become multiple chips", async () => {
  vi.spyOn(client, "GET").mockResolvedValue({
    data: [],
    response: new Response(),
  } as never);
  const changed = setup([{ name: "Art" }]);
  const input = screen.getByRole("combobox", { name: "标签" });
  fireEvent.change(input, { target: { value: "ＡＲＴ" } });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "添加" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.keyDown(input, { key: "Enter" });
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toMatch(/已添加/);
});

test("a pending catalog cannot turn an existing tag into an unversioned new name", async () => {
  let release!: (value: never) => void;
  vi.spyOn(client, "GET").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }) as never,
  );
  const changed = setup();
  const input = screen.getByRole("combobox", { name: "标签" });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "已有标签" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(changed).not.toHaveBeenCalled();
  release({
    data: [{ id: "existing", name: "已有标签", revision: 7 }],
    response: new Response(),
  } as never);
  await screen.findByRole("option", { name: "已有标签" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(changed).toHaveBeenLastCalledWith([
    { id: "existing", name: "已有标签", revision: 7 },
  ]);
});

test("retrying catalog failure neither submits the author form nor loses the pending tag text", async () => {
  vi.spyOn(client, "GET")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      data: [{ id: "existing", name: "已有标签", revision: 7 }],
      response: new Response(),
    } as never);
  const changed = setup();
  const input = screen.getByRole("combobox", { name: "标签" });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "已有标签" } });
  fireEvent.click(await screen.findByRole("button", { name: "重试" }));
  expect(changed).not.toHaveBeenCalled();
  expect((input as HTMLInputElement).value).toBe("已有标签");
  await screen.findByRole("option", { name: "已有标签" });
});
