import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
// Selected A artwork is the master; never regenerate it from the retired v2 SVG.
const source = path.join(root, "public/brand/deerhux-a-light.png");
const temporary = mkdtempSync(path.join(root, ".brand-icons-"));
try {
  // Normalize generated artwork to one export envelope; discard stray alpha
  // outside the tile without changing the selected symbol or its materials.
  for (const [theme, left, top, width, height] of [
    ["light", 86, 108, 1080, 1054],
    ["dark", 80, 100, 1092, 1050],
  ]) {
    const mask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="960"><rect width="960" height="960" rx="222" fill="white"/></svg>');
    const tile = await sharp(path.join(root, `public/brand/source/deerhux-a-${theme}.png`))
      .extract({ left, top, width, height }).resize(960, 960)
      .composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
    await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#00000000" } })
      .composite([{ input: tile, left: 32, top: 32 }]).png()
      .toFile(path.join(root, `public/brand/deerhux-a-${theme}.png`));
  }
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
    ["icon.icns", "src-tauri/icons/icon.icns"],
    ["icon.ico", "src-tauri/icons/icon.ico"],
    ["icon.ico", "app/favicon.ico"],
  ]) copyFileSync(path.join(temporary, "generated", generated), path.join(root, target));
  await sharp(source).resize(256, 256).png().toFile(path.join(root, "public/brand/deerhux-v2-icon-256.png"));
  for (const theme of ["light", "dark"]) {
    await sharp(path.join(root, `public/brand/deerhux-a-${theme}.png`))
      .resize(256, 256).png().toFile(path.join(root, `public/brand/deerhux-a-${theme}-256.png`));
  }
  console.log("Updated desktop PNG/ICNS/ICO, web icon and favicon.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
