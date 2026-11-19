import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const hub = process.env.NODEKO_DEV_HUB ?? "http://127.0.0.1:4170";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("../src/shared", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    proxy: {
      "/api": { target: hub, changeOrigin: false },
      "/mcp": { target: hub, changeOrigin: false },
      "/install": { target: hub, changeOrigin: false },
      "/agent": { target: hub, ws: true, changeOrigin: false },
    },
  },
});
