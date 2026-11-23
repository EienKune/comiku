import { expect, test, vi } from "vitest";
import { unzipSync } from "fflate";
import { afterEach } from "vitest";
import {
  browserArchiveLimit,
  buildMaterialArchive,
  downloadBrowserMaterials,
  type MaterialManifest,
} from "./typeset-materials-download";
afterEach(() => vi.unstubAllGlobals());

const bytes = new Uint8Array([1, 2, 3]);
const checksum =
  "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
test("browser archive preserves exact page bytes and LabelPlus encoding", async () => {
  const fetcher = vi.fn(async () => new Response(bytes));
  const archive = await buildMaterialArchive(
    {
      translationFileName: "翻译.txt",
      translationBase64: "//4=",
      images: [
        {
          fileName: "1-001.png",
          size: 3,
          checksum,
          url: "https://files.invalid/page",
        },
      ],
    },
    fetcher,
  );
  expect(unzipSync(archive)).toEqual({
    "1-001.png": bytes,
    "翻译.txt": new Uint8Array([255, 254]),
  });
});
test("corrupt or truncated images never produce an archive", async () => {
  await expect(
    buildMaterialArchive(
      {
        translationFileName: "text.txt",
        translationBase64: "",
        images: [{ fileName: "page.png", size: 3, checksum, url: "page" }],
      },
      async () => new Response(new Uint8Array([1, 2])),
    ),
  ).rejects.toThrow("校验失败");
});
test("downloads have a shared six-request concurrency bound and stop on cancellation", async () => {
  let active = 0,
    maximum = 0;
  const fetcher = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return new Response(bytes);
  };
  await buildMaterialArchive(
    {
      translationFileName: "text.txt",
      translationBase64: "",
      images: Array.from({ length: 20 }, (_, i) => ({
        fileName: `${i}.png`,
        size: 3,
        checksum,
        url: `${i}`,
      })),
    },
    fetcher,
  );
  expect(maximum).toBe(6);
  const controller = new AbortController();
  controller.abort();
  await expect(
    buildMaterialArchive(
      { translationFileName: "text.txt", translationBase64: "", images: [] },
      fetcher,
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("large materials select the supported fallback before signing or freezing", async () => {
  const fetcher = vi.fn<(url: string) => Promise<Response>>(async () =>
    Response.json({ id: "material", totalBytes: browserArchiveLimit + 1 }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(
    await downloadBrowserMaterials({
      workId: "work",
      expectedRevision: 4,
      expectedEditorEpoch: 2,
      idempotencyKey: "intent",
    }),
  ).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("/api/works/work/typeset/materials");
});

test("expired signatures renew the same manifest once without mixing changed files", async () => {
  const image = { fileName: "page.png", size: 3, checksum, url: "old" };
  const renew = vi.fn(
    async () =>
      ({ images: [{ ...image, url: "renewed" }] }) as MaterialManifest,
  );
  const fetcher = vi.fn(async (url: string) =>
    url === "old" ? new Response(null, { status: 403 }) : new Response(bytes),
  );
  await buildMaterialArchive(
    { translationFileName: "text.txt", translationBase64: "", images: [image] },
    fetcher,
    undefined,
    renew,
  );
  expect(renew).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual(["old", "renewed"]);
  await expect(
    buildMaterialArchive(
      {
        translationFileName: "text.txt",
        translationBase64: "",
        images: [image],
      },
      fetcher,
      undefined,
      async () =>
        ({
          images: [{ ...image, url: "renewed", checksum: "changed" }],
        }) as MaterialManifest,
    ),
  ).rejects.toThrow("材料已更新");
});

function materialFixture(count = 14): MaterialManifest {
  return {
    id: "material",
    fileName: "materials.zip",
    translationVersionId: "translation",
    sourceAssetRevision: 1,
    workRevision: 4,
    editorEpoch: 2,
    totalBytes: count * bytes.length + 2,
    translationFileName: "翻译.txt",
    translationBase64: "//4=",
    images: Array.from({ length: count }, (_, index) => ({
      fileName: `${index + 1}.png`,
      size: bytes.length,
      checksum,
      url: `old/${index}`,
    })),
  };
}

function refreshedFixture(material: MaterialManifest): MaterialManifest {
  return {
    ...material,
    images: material.images.map((image, index) => ({
      ...image,
      url: `renewed/${index}`,
    })),
  };
}

test.each(["403", "hidden 403"])(
  "%s shares one renewal and gives later workers fresh URLs in manifest order",
  async (failure) => {
    const material = materialFixture();
    let releaseRenewal!: () => void;
    const renew = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseRenewal = resolve;
      });
      return refreshedFixture(material);
    });
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith("old/")) {
        if (failure === "hidden 403") throw new TypeError("Failed to fetch");
        return new Response(null, { status: 403 });
      }
      // Network completion order must not become archive entry order.
      await new Promise((resolve) =>
        setTimeout(resolve, Number(url.split("/")[1]) % 3),
      );
      return new Response(bytes);
    });
    const result = buildMaterialArchive(material, fetcher, undefined, renew);
    void result.catch(() => {});
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
    releaseRenewal();
    const extracted = unzipSync(await result);
    expect(Object.keys(extracted)).toEqual([
      ...material.images.map((image) => image.fileName),
      material.translationFileName,
    ]);
    for (const image of material.images)
      expect(extracted[image.fileName]).toEqual(bytes);
    expect(extracted[material.translationFileName]).toEqual(
      new Uint8Array([255, 254]),
    );
    expect(renew).toHaveBeenCalledTimes(1);
    expect(
      fetcher.mock.calls.filter(([url]) => url.startsWith("old/")),
    ).toHaveLength(6);
    expect(fetcher).toHaveBeenCalledTimes(material.images.length + 6);
  },
);

test("signatures can first expire in a later worker wave", async () => {
  const material = materialFixture();
  const renew = vi.fn(async () => refreshedFixture(material));
  const fetcher = vi.fn(async (url: string) => {
    if (url.startsWith("old/") && Number(url.split("/")[1]) >= 6)
      throw new TypeError("Failed to fetch");
    return new Response(bytes);
  });
  expect(
    Object.keys(
      unzipSync(
        await buildMaterialArchive(material, fetcher, undefined, renew),
      ),
    ),
  ).toHaveLength(material.images.length + 1);
  expect(renew).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.some(([url]) => url.startsWith("renewed/"))).toBe(
    true,
  );
});

test.each(["403", "network"])(
  "persistent %s failures have one renewal and a bounded retry",
  async (failure) => {
    const material = materialFixture(1);
    const networkError = new TypeError("persistent CORS or network failure");
    const fetcher = vi.fn(async () => {
      if (failure === "network") throw networkError;
      return new Response(null, { status: 403 });
    });
    const renew = vi.fn(async () => refreshedFixture(material));
    await expect(
      buildMaterialArchive(material, fetcher, undefined, renew),
    ).rejects.toThrow(failure === "network" ? networkError : "下载失败");
    expect(renew).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

test("a failed renewal surfaces its error without further image requests", async () => {
  const material = materialFixture();
  const fetcher = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  const renew = vi.fn(async () => {
    throw new Error("权限已变更");
  });
  await expect(
    buildMaterialArchive(material, fetcher, undefined, renew),
  ).rejects.toThrow("权限已变更");
  expect(renew).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(6);
});

test("cancellation during a shared renewal settles immediately without retries", async () => {
  const material = materialFixture();
  const controller = new AbortController();
  let finishRenewal!: (material: MaterialManifest) => void;
  const renew = vi.fn(
    () =>
      new Promise<MaterialManifest>((resolve) => {
        finishRenewal = resolve;
      }),
  );
  const fetcher = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  const result = buildMaterialArchive(
    material,
    fetcher,
    controller.signal,
    renew,
  );
  const outcome = result.catch((error: unknown) => error);
  await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
  controller.abort();
  expect(await outcome).toMatchObject({ name: "AbortError" });
  finishRenewal(refreshedFixture(material));
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledTimes(6);
});

test("an in-flight fetch aborted as TypeError must not renew", async () => {
  const material = materialFixture(1);
  const controller = new AbortController();
  const renew = vi.fn(async () => refreshedFixture(material));
  const fetcher = vi.fn(async () => {
    controller.abort();
    throw new TypeError("fetch aborted");
  });
  await expect(
    buildMaterialArchive(material, fetcher, controller.signal, renew),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(renew).not.toHaveBeenCalled();
});

test.each([
  [
    "filename",
    (material: MaterialManifest) => {
      material.images[1].fileName = "changed.png";
    },
  ],
  [
    "checksum",
    (material: MaterialManifest) => {
      material.images[1].checksum = "changed";
    },
  ],
  [
    "size",
    (material: MaterialManifest) => {
      material.images[1].size += 1;
    },
  ],
  [
    "order",
    (material: MaterialManifest) => {
      material.images.reverse();
    },
  ],
  [
    "missing image",
    (material: MaterialManifest) => {
      material.images.pop();
    },
  ],
  [
    "extra image",
    (material: MaterialManifest) => {
      material.images.push({ ...material.images[0], fileName: "extra.png" });
    },
  ],
  [
    "missing URL",
    (material: MaterialManifest) => {
      delete material.images[1].url;
    },
  ],
] as const)(
  "renewal rejects a changed %s before fetching any renewed file",
  async (_, mutate) => {
    const material = materialFixture(2);
    const refreshed = refreshedFixture(material);
    mutate(refreshed);
    const fetcher = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      buildMaterialArchive(material, fetcher, undefined, async () => refreshed),
    ).rejects.toThrow("材料已更新");
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

test.each([404, 500])(
  "HTTP %s failures do not request new signatures",
  async (status) => {
    const material = materialFixture(1);
    const renew = vi.fn(async () => refreshedFixture(material));
    const fetcher = vi.fn(async () => new Response(null, { status }));
    await expect(
      buildMaterialArchive(material, fetcher, undefined, renew),
    ).rejects.toThrow("下载失败");
    expect(renew).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test("errors other than fetch TypeError do not request new signatures", async () => {
  const material = materialFixture(1);
  const renew = vi.fn(async () => refreshedFixture(material));
  const error = new Error("unexpected failure");
  await expect(
    buildMaterialArchive(
      material,
      async () => {
        throw error;
      },
      undefined,
      renew,
    ),
  ).rejects.toBe(error);
  expect(renew).not.toHaveBeenCalled();
});

test("body read errors and corrupt renewed bytes do not cause further renewal", async () => {
  const material = materialFixture(1);
  const renew = vi.fn(async () => refreshedFixture(material));
  const bodyError = new TypeError("body interrupted");
  await expect(
    buildMaterialArchive(
      material,
      async () => {
        const response = new Response(bytes);
        response.arrayBuffer = async () => {
          throw bodyError;
        };
        return response;
      },
      undefined,
      renew,
    ),
  ).rejects.toBe(bodyError);
  expect(renew).not.toHaveBeenCalled();
  await expect(
    buildMaterialArchive(
      material,
      async (url) => {
        if (url.startsWith("old/")) throw new TypeError("Failed to fetch");
        return new Response(new Uint8Array([3, 2, 1]));
      },
      undefined,
      renew,
    ),
  ).rejects.toThrow("校验失败");
  expect(renew).toHaveBeenCalledTimes(1);
});

test("cancellation on the renewed fetch preserves the cancellation error", async () => {
  const material = materialFixture(1);
  const controller = new AbortController();
  const renew = vi.fn(async () => refreshedFixture(material));
  await expect(
    buildMaterialArchive(
      material,
      async (url) => {
        if (url.startsWith("renewed/")) controller.abort();
        throw new TypeError("fetch failed");
      },
      controller.signal,
      renew,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(renew).toHaveBeenCalledTimes(1);
});

test("a new signature failing in a later wave never triggers another renewal", async () => {
  const material = materialFixture();
  const renew = vi.fn(async () => refreshedFixture(material));
  const fetcher = vi.fn(async (url: string) => {
    if (url.startsWith("old/") || Number(url.split("/")[1]) >= 6)
      throw new TypeError("persistent failure");
    return new Response(bytes);
  });
  await expect(
    buildMaterialArchive(material, fetcher, undefined, renew),
  ).rejects.toThrow("persistent failure");
  expect(renew).toHaveBeenCalledTimes(1);
  expect(
    fetcher.mock.calls.filter(([url]) => url === "renewed/6"),
  ).toHaveLength(1);
});
