import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev and in `vite preview` the browser talks to the API same-origin via
// /api; Vite proxies it to the FastAPI process. API_ORIGIN lets tests point
// at a spawned uvicorn on another port.
const apiTarget = process.env.API_ORIGIN ?? "http://127.0.0.1:8000";
const proxy = {
  "/api": {
    target: apiTarget,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy,
  },
  preview: {
    host: true,
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/unit/setup.ts"],
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
  },
});
