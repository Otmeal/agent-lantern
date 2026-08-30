import { defineConfig } from "tsup";

/**
 * Produces the self-contained daemon the overlay ships as a Tauri resource and
 * launches on startup. The output is CommonJS because Fastify and its
 * dependency tree are CommonJS, and bundling them into ESM leaves behind
 * `require()` calls esbuild cannot resolve at runtime. The `.cjs` extension
 * makes Node pick that format wherever the bundle is copied, independent of
 * any nearby `package.json`.
 */
export default defineConfig({
  entry: { "agent-lantern-daemon": "src/index.ts" },
  outDir: "dist-bundle",
  format: ["cjs"],
  platform: "node",
  target: "node20",
  clean: true,
  noExternal: [/.*/],
  outExtension: () => ({ js: ".cjs" }),
});
