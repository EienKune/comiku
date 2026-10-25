import { checkWorkerHealth } from "./worker-health.js";

try {
  if (process.argv[2] === "worker") {
    await checkWorkerHealth(
      process.env.WORKER_HEALTH_FILE ?? "/tmp/comiku-worker-health.json",
    );
  } else {
    const response = await fetch(
      `http://127.0.0.1:${process.env.PORT ?? "3000"}/api/health/ready`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (!response.ok) throw new Error("API is not ready");
  }
} catch {
  process.exitCode = 1;
}
