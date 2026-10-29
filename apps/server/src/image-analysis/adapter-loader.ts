import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Environment } from "../config/environment.js";
import {
  activateImageAnalysisAdapter,
  type ActiveImageAnalysisAdapter,
} from "./image-analysis-adapter.js";
import { createExampleImageAnalysisAdapter } from "./example-adapter.js";
import { createBaPixaiImageAnalysisAdapter } from "./adapters/ba-pixai/ba-pixai-adapter.js";

/** Only the administrator's process configuration can select executable code. */
export async function loadImageAnalysisAdapter(
  config: Environment["imageAnalysis"],
): Promise<ActiveImageAnalysisAdapter | null> {
  if (!config) return null;
  try {
    if (config.adapter === "example")
      return activateImageAnalysisAdapter(createExampleImageAnalysisAdapter());
    if (
      !["external", "ba-pixai"].includes(config.adapter) ||
      (config.adapter === "external" && !isAbsolute(config.modulePath)) ||
      !isAbsolute(config.configFile)
    )
      throw new Error();
    const info = await stat(config.configFile);
    if (!info.isFile() || info.size > 64 * 1024) throw new Error();
    const providerConfig: unknown = JSON.parse(
      await readFile(config.configFile, "utf8"),
    );
    if (
      !providerConfig ||
      typeof providerConfig !== "object" ||
      Array.isArray(providerConfig)
    )
      throw new Error();
    if (config.adapter === "ba-pixai")
      return activateImageAnalysisAdapter(
        createBaPixaiImageAnalysisAdapter(providerConfig),
      );
    const module = await import(pathToFileURL(config.modulePath).href);
    if (typeof module.createImageAnalysisAdapter !== "function")
      throw new Error();
    return activateImageAnalysisAdapter(
      await module.createImageAnalysisAdapter(providerConfig),
    );
  } catch {
    // Provider config, paths and module errors may contain credentials.
    throw new Error("Cannot load the configured image analysis adapter");
  }
}
