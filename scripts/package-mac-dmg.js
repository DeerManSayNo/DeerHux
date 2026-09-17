const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const layout = require("./dmg-layout.json");

if (process.platform !== "darwin") {
  console.error("package:mac-dmg can only run on macOS.");
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, "..");
const packageJson = require(path.join(repoRoot, "package.json"));
const tauriConfig = require(path.join(repoRoot, "src-tauri", "tauri.conf.json"));

const productName = tauriConfig.productName || packageJson.name;
const version = tauriConfig.version || packageJson.version;
const arch = os.arch() === "arm64" ? "aarch64" : os.arch();

const bundleRoot = path.join(repoRoot, "src-tauri", "target", "release", "bundle");
const appPath = path.join(bundleRoot, "macos", `${productName}.app`);
const dmgDir = path.join(bundleRoot, "dmg");
// A separate output is useful for validating installer artwork against an
// existing app bundle, without replacing the last release image.
const outputIndex = process.argv.indexOf("--output");
if (outputIndex !== -1 && !process.argv[outputIndex + 1]) {
  throw new Error("--output requires a DMG path");
}
const dmgPath = outputIndex === -1
  ? path.join(dmgDir, `${productName}_${version}_${arch}.dmg`)
  : path.resolve(process.argv[outputIndex + 1]);
const backgroundPath = path.join(repoRoot, "assets", "dmg-background.tiff");

if (!fs.existsSync(appPath)) {
  console.error(`Missing app bundle: ${appPath}`);
  console.error("Run `tauri build --bundles app` before packaging the DMG.");
  process.exit(1);
}

run(process.execPath, [path.join(__dirname, "render-dmg-background.js")]);

fs.mkdirSync(dmgDir, { recursive: true });
fs.mkdirSync(path.dirname(dmgPath), { recursive: true });

const stagingDir = fs.mkdtempSync(path.join(dmgDir, `${packageJson.name}-dmg-staging-`));
const writableDmgPath = path.join(dmgDir, `${packageJson.name}-dmg-layout-${process.pid}.dmg`);
const pendingDmgPath = dmgPath.replace(/\.dmg$/i, "") + `.pending-${process.pid}.dmg`;
// Finder resolves disk object specifiers by name. A unique temporary name
// prevents an already-mounted release from receiving this image's layout.
const layoutVolumeName = `${productName} Installer ${process.pid}`;
const mountPoint = path.join("/Volumes", layoutVolumeName);
let mounted = false;
let detachTarget = mountPoint;

try {
  fs.cpSync(appPath, path.join(stagingDir, `${productName}.app`), { recursive: true });
  fs.symlinkSync("/Applications", path.join(stagingDir, "Applications"));
  fs.mkdirSync(path.join(stagingDir, ".background"));
  fs.copyFileSync(backgroundPath, path.join(stagingDir, ".background", "background.tiff"));

  // Finder stores the visual layout in .DS_Store. Build a writable image first,
  // configure its mounted volume, then convert it to the compressed release DMG.
  run("hdiutil", [
    "create",
    "-volname",
    layoutVolumeName,
    "-srcfolder",
    stagingDir,
    "-ov",
    "-format",
    "UDRW",
    writableDmgPath,
  ]);

  run("hdiutil", [
    "attach",
    "-readwrite",
    "-noverify",
    "-mountpoint",
    mountPoint,
    writableDmgPath,
  ]);
  mounted = true;
  const diskInfo = execFileSync("diskutil", ["info", "-plist", mountPoint], { encoding: "utf8" });
  const deviceId = diskInfo.match(/<key>DeviceIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (!deviceId) throw new Error("Cannot determine installer volume device");
  // Renaming the volume changes its mount point; the device remains stable.
  detachTarget = `/dev/${deviceId}`;

  configureFinderWindow(mountPoint);
  run("diskutil", ["renameVolume", mountPoint, productName]);
  run("sync", []);
  run("hdiutil", ["detach", detachTarget]);
  mounted = false;

  // ULFO uses LZMA compression — ~10% smaller than zlib's UDZO.
  // Requires macOS 10.11+ to mount; our minimumSystemVersion is 11.0.
  run("hdiutil", ["convert", writableDmgPath, "-format", "ULFO", "-ov", "-o", pendingDmgPath]);
  run("hdiutil", ["verify", pendingDmgPath]);
  fs.renameSync(pendingDmgPath, dmgPath);

  console.log(`Created DMG: ${dmgPath}`);
} finally {
  if (mounted) {
    try {
      run("hdiutil", ["detach", detachTarget, "-force"]);
      mounted = false;
    } catch {
      // Preserve the original packaging error if detaching the temporary image fails.
    }
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });
  if (!mounted) fs.rmSync(writableDmgPath, { force: true });
  fs.rmSync(pendingDmgPath, { force: true });
  // Never recursively remove a mount point if detaching failed.
  if (!mounted && fs.existsSync(mountPoint)) fs.rmdirSync(mountPoint);
}

function configureFinderWindow(volumePath) {
  const backgroundFile = path.join(volumePath, ".background", "background.tiff");
  const script = `
set backgroundImage to POSIX file "${escapeAppleScript(backgroundFile)}" as alias
tell application "Finder"
  repeat 20 times
    if exists disk "${escapeAppleScript(layoutVolumeName)}" then exit repeat
    delay 0.25
  end repeat
  set volumeDisk to disk "${escapeAppleScript(layoutVolumeName)}"
  open volumeDisk
  delay 1
  set volumeWindow to container window of volumeDisk
  set current view of volumeWindow to icon view
  set toolbar visible of volumeWindow to false
  set statusbar visible of volumeWindow to false
  set pathbar visible of volumeWindow to false
  set bounds of volumeWindow to {100, 100, ${100 + layout.width}, ${100 + layout.height + layout.titleBarHeight}}
  set viewOptions to the icon view options of volumeWindow
  set arrangement of viewOptions to not arranged
  set icon size of viewOptions to ${layout.iconSize}
  set text size of viewOptions to 13
  set shows item info of viewOptions to false
  set shows icon preview of viewOptions to false
  set background picture of viewOptions to backgroundImage
  set position of item "${escapeAppleScript(`${productName}.app`)}" of volumeDisk to {${layout.app.x}, ${layout.app.y}}
  set position of item "Applications" of volumeDisk to {${layout.applications.x}, ${layout.applications.y}}
  update volumeDisk without registering applications
  delay 2
  close volumeWindow
  delay 1
end tell
`;

  execFileSync("osascript", ["-e", script], { cwd: repoRoot, stdio: "inherit" });
}

function escapeAppleScript(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status || 1}`);
  }
}
