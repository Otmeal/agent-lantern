import { defineConfig } from "vite";

export default defineConfig({
  // Keep Tauri's Rust output out of the dev server's watch set; chokidar
  // otherwise crashes with EBUSY when cargo rewrites files in src-tauri/target
  // while the dev server is starting.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
