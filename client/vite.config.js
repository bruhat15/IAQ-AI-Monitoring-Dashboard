import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/history": "http://localhost:3000",
      "/latest": "http://localhost:3000",
      "/data": "http://localhost:3000",
      "/stream": {
        target: "http://localhost:3000",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist"
  }
});
