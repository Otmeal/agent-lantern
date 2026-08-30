#!/usr/bin/env node
/**
 * 把各 workspace 產生的安裝檔／壓縮檔收集到 repo 最外層的 dist-packages/。
 *
 * 目前來源：
 *   - apps/overlay/src-tauri/target/release/bundle/{msi,nsis}/  (Tauri 安裝檔)
 *   - scripts/install-remote.sh                                 (遠端安裝腳本)
 *
 * 加上 --skip-installers 時只收集遠端安裝腳本，讓 pack:reporter 不必先建置
 * overlay 也能執行。
 */
import { chmod, cp, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(rootDir, "dist-packages");
const bundleDir = join(rootDir, "apps/overlay/src-tauri/target/release/bundle");
const skipInstallers = process.argv.includes("--skip-installers");

async function collectFrom(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const copied = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const from = join(dir, entry.name);
    const to = join(outDir, entry.name);
    await cp(from, to);
    copied.push({ name: entry.name, size: (await stat(to)).size });
  }
  return copied;
}

await mkdir(outDir, { recursive: true });

const copied = [];

// 遠端安裝腳本要和 reporter tarball 放在一起，使用者才能把整個 dist-packages
// 丟到遠端主機後直接執行。
const installScriptName = "install-remote.sh";
const installScriptTarget = join(outDir, installScriptName);
await cp(join(rootDir, "scripts", installScriptName), installScriptTarget);
await chmod(installScriptTarget, 0o755);
copied.push({
  name: installScriptName,
  size: (await stat(installScriptTarget)).size,
});

if (!skipInstallers) {
  const installers = [];
  for (const target of ["msi", "nsis"]) {
    installers.push(...(await collectFrom(join(bundleDir, target))));
  }

  if (installers.length === 0) {
    console.error(
      `[collect-artifacts] 找不到任何安裝檔，請先執行 overlay 的 tauri build。\n` +
        `  預期位置：${bundleDir}`,
    );
    process.exit(1);
  }
  copied.push(...installers);
}

console.log(`[collect-artifacts] 已收集到 ${outDir}`);
for (const { name, size } of copied) {
  console.log(`  - ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}
