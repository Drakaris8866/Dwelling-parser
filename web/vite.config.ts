import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)), plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: false, proxy: { "/api": `http://127.0.0.1:${loadEnv(mode, process.cwd(), "CATALOG_")["CATALOG_PORT"] ?? 3000}` } },
  build: { outDir: "dist", emptyOutDir: true }
}));
