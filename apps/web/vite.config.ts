import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const { PORT = "3000" } = loadEnv(mode, root, "PORT");

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": `http://127.0.0.1:${PORT}`,
      },
    },
    preview: {
      port: 4173,
    },
  };
});
