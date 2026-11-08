import { copyFile, mkdir } from "node:fs/promises";

async function copyAdapterAssets(directory, names) {
  const source = new URL(`../src/${directory}/`, import.meta.url);
  const target = new URL(`../dist/${directory}/`, import.meta.url);
  for (const name of names) {
    await mkdir(new URL(".", new URL(name, target)), { recursive: true });
    await copyFile(new URL(name, source), new URL(name, target));
  }
}

await copyAdapterAssets("source-ingestion/adapters/gallery-dl", [
  "README.md",
  "python/adapter.py",
  "python/pixiv_paging.py",
  "python/pixiv_caption.py",
  "python/requirements.txt",
]);

await copyAdapterAssets("image-analysis/adapters/ba-pixai", [
  "README.md",
  "python/pixai_bridge.py",
  "python/pixai_loader.py",
  "python/requirements.txt",
  "python/pixai/frozen_feature_helper.py",
  "python/pixai/tagger_pipeline.py",
  "python/pixai/preprocessor_config.json",
  "python/pixai/NOTICE.md",
  "python/pixai/LICENSE",
]);
