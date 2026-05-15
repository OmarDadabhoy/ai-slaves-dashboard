import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port 5179 is dedicated to AI Slaves Dashboard.
// strictPort = fail loudly if taken (vs silent fallback to 5174/etc).
// host 127.0.0.1 avoids IPv6 vs IPv4 mismatches on macOS.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5179,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5176",
        changeOrigin: true,
      },
    },
  },
});
