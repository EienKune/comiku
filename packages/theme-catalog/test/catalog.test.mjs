import assert from "node:assert/strict";
import test from "node:test";
import {
  themeCatalog,
  createThemeCatalog,
  defaultThemePack,
  installedThemePacks,
} from "../src/index.mjs";

test("default-only composition retains six original presets and resolves unavailable IDs", () => {
  const catalog = createThemeCatalog([defaultThemePack]);
  assert.deepEqual(catalog.presetIds, [
    "teal",
    "sky",
    "lavender",
    "pink",
    "amber",
    "minimal",
  ]);
  assert.deepEqual(catalog.styleIds, ["soft", "minimal"]);
  assert.equal(catalog.resolvePresetId("arona"), "teal");
  assert.equal(catalog.resolvePresetId("minimal"), "minimal");
  assert.equal(
    themeCatalog.presetIds.length,
    installedThemePacks.reduce((total, pack) => total + pack.presets.length, 0),
  );
});
test("composition rejects missing defaults, duplicate IDs and unsafe module names", () => {
  assert.throws(() => createThemeCatalog([]));
  assert.throws(() => createThemeCatalog([defaultThemePack, defaultThemePack]));
  assert.throws(() =>
    createThemeCatalog([defaultThemePack, { id: "../other", presets: [] }]),
  );
  assert.throws(() =>
    createThemeCatalog([
      defaultThemePack,
      { id: "other", presets: defaultThemePack.presets },
    ]),
  );
});
