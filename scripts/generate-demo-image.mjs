import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Resolve the existing server dependency; do not add a second Sharp version.
const require = createRequire(
  new URL("../apps/server/package.json", import.meta.url),
);
const sharp = require("sharp");
const source = new URL(
  "../apps/web/public/samples/demo-work.svg",
  import.meta.url,
);
const target = new URL(
  "../apps/web/public/samples/demo-work.png",
  import.meta.url,
);
await sharp(await readFile(source))
  .png()
  .toFile(fileURLToPath(target));
console.log("Generated apps/web/public/samples/demo-work.png");
