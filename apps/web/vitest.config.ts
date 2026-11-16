import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { themePacksPlugin } from "./theme-packs-plugin";

export default defineConfig({
  plugins: [react(), themePacksPlugin()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    clearMocks: true,
  },
});
