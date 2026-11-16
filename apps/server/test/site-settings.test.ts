import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import type { Response } from "express";
import {
  normalizeSiteName,
  siteThemePresetIds,
} from "../src/site/site-theme-presets.js";
import { processSiteIcon } from "../src/site/site-icon-processor.js";
import { runSiteMaintenance } from "../src/site/site-worker.js";
import { createThemeCatalog, defaultThemePack } from "@comiku/theme-catalog";
import { siteDto, SiteService } from "../src/site/site.service.js";
import { SiteController } from "../src/site/site.controller.js";
import type { SiteSettingsDto } from "../src/site/site.dto.js";
import type { SiteSettings } from "../src/generated/prisma/client.js";

async function readPublicSite(controller: SiteController, condition?: string) {
  const headers = new Map<string, string>();
  let status = 200;
  const body = await controller.publicSettings(condition, {
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    status(value: number) {
      status = value;
      return this;
    },
  } as unknown as Response);
  return { body, status, etag: headers.get("ETag")!, headers };
}

test("public site revalidation restores a reinstalled theme without a settings revision change", async () => {
  const saved: SiteSettings = {
    id: "global",
    name: "团队站点",
    themePresetId: "fixture-warm",
    iconAssetId: null,
    revision: 4,
    updatedAt: new Date(),
  };
  let catalog = createThemeCatalog([defaultThemePack]);
  const controller = new SiteController(
    { readPublic: async () => siteDto(saved, catalog) } as never,
    {} as never,
  );
  const fallback = await readPublicSite(controller);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body?.themePresetId, "teal");
  catalog = createThemeCatalog([
    defaultThemePack,
    {
      id: "fixture",
      preview: false,
      presets: [
        {
          id: "fixture-warm",
          name: "Fixture",
          brand: "#abcdef",
          style: "fixture",
        },
      ],
    },
  ]);
  const restored = await readPublicSite(controller, fallback.etag);
  assert.equal(restored.status, 200);
  assert.notEqual(restored.etag, fallback.etag);
  assert.equal(restored.body?.themePresetId, "fixture-warm");
  assert.equal(restored.body?.revision, 4);
  const unchanged = await readPublicSite(controller, restored.etag);
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body, undefined);
});

test("public site ETags cover the complete response and retain conditional request semantics", async () => {
  const initial: SiteSettingsDto = {
    name: "团队站点",
    themePresetId: "teal",
    iconVersion: null,
    revision: 4,
  };
  let settings = initial;
  const controller = new SiteController(
    { readPublic: async () => ({ ...settings }) } as never,
    {} as never,
  );
  const first = await readPublicSite(controller);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, initial);
  assert.equal(
    first.headers.get("Cache-Control"),
    "public, max-age=0, must-revalidate",
  );
  for (const condition of [
    first.etag,
    `W/${first.etag}`,
    `"other", W/${first.etag} `,
    "*",
  ]) {
    const cached = await readPublicSite(controller, condition);
    assert.equal(cached.status, 304, condition);
    assert.equal(cached.body, undefined);
    assert.equal(cached.etag, first.etag);
  }
  const unrelated = await readPublicSite(controller, '"other"');
  assert.equal(unrelated.status, 200);
  assert.deepEqual(unrelated.body, initial);
  for (const change of [
    { name: "新站点" },
    { iconVersion: "11111111-1111-4111-8111-111111111111" },
    { revision: 5 },
  ]) {
    settings = { ...initial, ...change };
    const changed = await readPublicSite(controller, first.etag);
    assert.equal(changed.status, 200);
    assert.notEqual(changed.etag, first.etag);
    assert.deepEqual(changed.body, settings);
  }
});

test("removed site themes fall back while branding, revision and stored selection remain intact", () => {
  const saved: SiteSettings = {
    id: "global",
    name: "团队站点",
    themePresetId: "fixture-warm",
    iconAssetId: "11111111-1111-4111-8111-111111111111",
    revision: 4,
    updatedAt: new Date(),
  };
  const base = createThemeCatalog([defaultThemePack]);
  assert.deepEqual(siteDto(saved, base), {
    name: saved.name,
    iconVersion: saved.iconAssetId,
    revision: 4,
    themePresetId: "teal",
  });
  assert.equal(saved.themePresetId, "fixture-warm");
  const restored = createThemeCatalog([
    defaultThemePack,
    {
      id: "fixture",
      preview: false,
      presets: [
        {
          id: "fixture-warm",
          name: "Fixture",
          brand: "#abcdef",
          style: "fixture",
        },
      ],
    },
  ]);
  assert.equal(siteDto(saved, restored).themePresetId, "fixture-warm");
});

test("site names are plain bounded Unicode and existing themes remain available", () => {
  assert.equal(normalizeSiteName("  夏莱烤肉屋  "), "夏莱烤肉屋");
  assert.equal(normalizeSiteName("😀".repeat(64)), "😀".repeat(64));
  for (const value of ["", " ", "a".repeat(65), "a\nb", "a\u202eb"])
    assert.throws(() => normalizeSiteName(value));
  assert.equal(
    normalizeSiteName("<script>plain text</script>"),
    "<script>plain text</script>",
  );
  assert.deepEqual(
    siteThemePresetIds.filter((id) => !id.endsWith("-dark")).slice(0, 6),
    ["teal", "sky", "lavender", "pink", "amber", "minimal"],
  );
  assert.equal(new Set(siteThemePresetIds).size, siteThemePresetIds.length);
});

test("saving branding preserves an unavailable stored theme until a replacement is explicitly submitted", async () => {
  let row: SiteSettings = {
    id: "global",
    name: "原站点",
    themePresetId: "removed-theme",
    iconAssetId: null,
    revision: 4,
    updatedAt: new Date(),
  };
  const tx = {
    siteSettings: {
      upsert: async () => row,
      update: async ({
        data,
      }: {
        data: {
          name: string;
          themePresetId: string;
          revision: { increment: number };
        };
      }) => {
        row = {
          ...row,
          name: data.name,
          themePresetId: data.themePresetId,
          revision: row.revision + data.revision.increment,
        };
        return row;
      },
    },
    accountAudit: { create: async () => ({}) },
  };
  const service = new SiteService(
    {
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(tx),
    } as never,
    {} as never,
  );
  service.authorize = async () => {};
  service.lock = async () => {};
  const actor = { userId: "fixture", sessionId: "fixture" };
  const branded = await service.update(actor, {
    name: "新站点",
    expectedRevision: 4,
    iconAction: "keep",
  });
  assert.equal(branded.name, "新站点");
  assert.equal(branded.themePresetId, "teal");
  assert.equal(row.themePresetId, "removed-theme");
  const changed = await service.update(actor, {
    name: "新站点",
    expectedRevision: 5,
    iconAction: "keep",
    themePresetId: "sky",
  });
  assert.equal(changed.themePresetId, "sky");
  assert.equal(row.themePresetId, "sky");
});

test("site maintenance failure retains its own minute cadence and stops on abort", async () => {
  const stopping = new AbortController(),
    waits: number[] = [];
  let runs = 0;
  await runSiteMaintenance(
    {
      async cleanup() {
        if (++runs === 1) throw new Error("synthetic");
        stopping.abort();
      },
    },
    stopping.signal,
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.equal(runs, 2);
  assert.deepEqual(waits, [60_000, 60_000]);
});

test("site icons decode bounded static rasters and produce padded PNG derivatives", async () => {
  const png = await sharp({
    create: { width: 80, height: 40, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  const result = await processSiteIcon(png, "image/png");
  for (const size of [32, 256] as const) {
    const info = await sharp(result[size]).metadata();
    assert.equal(info.width, size);
    assert.equal(info.height, size);
    assert.equal(info.format, "png");
  }
  await assert.rejects(processSiteIcon(png, "image/jpeg"));
  await assert.rejects(
    processSiteIcon(Buffer.from("not an image"), "image/png"),
  );
  await assert.rejects(
    processSiteIcon(Buffer.alloc(5 * 1024 * 1024 + 1), "image/png"),
  );
  const large = await sharp({
    create: { width: 2001, height: 2000, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await assert.rejects(processSiteIcon(large, "image/png"));
});
