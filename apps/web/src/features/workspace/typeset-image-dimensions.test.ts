import { afterEach, expect, test, vi } from "vitest";
import { typesetImageDimensions } from "./typeset-image-dimensions";

afterEach(() => vi.unstubAllGlobals());

test("shares a file's decoded dimensions between local preview and upload and closes the bitmap", async () => {
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width: 640, height: 960, close }));
  vi.stubGlobal("createImageBitmap", decode);
  const file = new File(["synthetic"], "page.png");
  expect(await typesetImageDimensions(file)).toEqual({
    width: 640,
    height: 960,
  });
  expect(await typesetImageDimensions(file)).toEqual({
    width: 640,
    height: 960,
  });
  expect(decode).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

test("rejects invalid dimensions and retries a previously failed decode", async () => {
  const decode = vi
    .fn()
    .mockRejectedValueOnce(new Error("corrupt"))
    .mockResolvedValueOnce({ width: 0, height: 1, close: vi.fn() })
    .mockResolvedValue({ width: 1, height: 2, close: vi.fn() });
  vi.stubGlobal("createImageBitmap", decode);
  const file = new File(["synthetic"], "page.png");
  await expect(typesetImageDimensions(file)).rejects.toThrow("corrupt");
  await expect(typesetImageDimensions(file)).rejects.toThrow("图片尺寸");
  await expect(typesetImageDimensions(file)).resolves.toEqual({
    width: 1,
    height: 2,
  });
});

test("reads intrinsic dimensions and releases the temporary URL without ImageBitmap", async () => {
  vi.stubGlobal("createImageBitmap", undefined);
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = () => "blob:dimensions";
      static revokeObjectURL = revoke;
    },
  );
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 42;
      naturalHeight = 84;
      onload?: () => void;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  await expect(
    typesetImageDimensions(new File(["x"], "page.png")),
  ).resolves.toEqual({ width: 42, height: 84 });
  expect(revoke).toHaveBeenCalledWith("blob:dimensions");
});
