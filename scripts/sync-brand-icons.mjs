import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "public/brand/deerhux-v2-icon.svg");
const temporary = mkdtempSync(path.join(root, ".brand-icons-"));
try {
  const input = path.join(temporary, "source.png");
  await sharp(source).resize(1024, 1024).png().toFile(input);
  const result = spawnSync(process.execPath, [
    path.join(root, "node_modules/@tauri-apps/cli/tauri.js"),
    "icon", input, "--output", path.join(temporary, "generated"),
  ], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Tauri icon generation failed");
  for (const target of ["src-tauri/icons/icon.png", "public/deerhux.png", "public/brand/deerhux-v2-icon-1024.png"]) {
    copyFileSync(input, path.join(root, target));
  }
  for (const [generated, target] of [
    ["icon.icns", "src-tauri/icons/icon copy.icns"],
    ["icon.ico", "src-tauri/icons/icon.ico"],
    ["icon.ico", "app/favicon.ico"],
  ]) copyFileSync(path.join(temporary, "generated", generated), path.join(root, target));
  await sharp(source).resize(256, 256).png().toFile(path.join(root, "public/brand/deerhux-v2-icon-256.png"));
  console.log("Updated desktop PNG/ICNS/ICO, web icon and favicon.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
