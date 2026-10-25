import { readFile, rename, writeFile } from "node:fs/promises";

export async function writeWorkerHealth(file: string, details: object = {}) {
  await writeFile(
    file + ".next",
    JSON.stringify({
      at: Date.now(),
      pid: process.pid,
      rss: process.memoryUsage().rss,
      ...details,
    }),
    { mode: 0o600 },
  );
  await rename(file + ".next", file);
}

export async function checkWorkerHealth(file: string, now = Date.now()) {
  const value = JSON.parse(await readFile(file, "utf8")) as { at?: number };
  if (
    typeof value.at !== "number" ||
    value.at > now + 5_000 ||
    now - value.at > 45_000
  )
    throw new Error("Worker heartbeat is stale");
}
