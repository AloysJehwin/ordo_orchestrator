import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.ORDO_API ?? "http://localhost:8080";
// Keep the browser's Host header (Vite's string shorthand rewrites it to the API's): the API's CSRF check
// compares it with the request's Origin, and wallet sign-in messages use it as their domain.
const toApi = { target: api, changeOrigin: false };
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/v1": toApi, "/health": toApi } },
  build: { outDir: "dist", sourcemap: true },
});
