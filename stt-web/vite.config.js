import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 4173,
    fs: {
      // allow parent dir so we can import ../config.json
      allow: [path.resolve(__dirname, "..")],
    },
  },
});
