import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const { engines, packageManager } = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
);
const pnpmVersion = packageManager.split("@")[1];
const errors = [];
if (process.versions.node !== engines.node) {
  errors.push(`Use Node.js ${engines.node}; found ${process.versions.node}.`);
}
for (const file of [".node-version", ".nvmrc"]) {
  if (readFileSync(new URL(file, root), "utf8").trim() !== engines.node) {
    errors.push(`${file} must match package.json engines.node.`);
  }
}
if (engines.pnpm !== pnpmVersion) {
  errors.push("engines.pnpm must match packageManager.");
}
const userAgent = process.env.npm_config_user_agent;
if (userAgent && userAgent.split(" ")[0] !== `pnpm/${pnpmVersion}`) {
  errors.push(`Use pnpm ${pnpmVersion}.`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}
