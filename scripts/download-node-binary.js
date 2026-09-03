#!/usr/bin/env node
/**
 * Download the Node.js binary for the target platform as a Tauri sidecar.
 *
 * Usage:
 *   node scripts/download-node-binary.js                  # current platform
 *   node scripts/download-node-binary.js --platform win32 # Windows x64
 *   node scripts/download-node-binary.js --platform darwin --arch x64  # Intel Mac
 *   node scripts/download-node-binary.js --list           # show all targets
 *
 * The binary is placed in src-tauri/binaries/ with Tauri's expected naming convention:
 *   node-{targetTriple}[.exe]
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, execSync } = require("child_process");
const { parseArgs } = require("util");

const { values: args } = parseArgs({
  options: {
    platform: { type: "string" },
    arch:     { type: "string" },
    list:     { type: "boolean", default: false },
  },
  strict: false,
});

// ── Platform → Node.js download manifest ──────────────────────────────────────
// pi-coding-agent and its undici dependency require Node >=22.19.0.
const NODE_VERSION = "22.23.2"; // Node 22 LTS
const NETWORK_IDLE_TIMEOUT_MS = 30_000;

const TARGETS = {
  "darwin-arm64": {
    nodeTriple: "darwin-arm64",
    tauriTriple: "aarch64-apple-darwin",
    ext: "",
  },
  "darwin-x64": {
    nodeTriple: "darwin-x64",
    tauriTriple: "x86_64-apple-darwin",
    ext: "",
  },
  "win32-x64": {
    nodeTriple: "win-x64",
    tauriTriple: "x86_64-pc-windows-msvc",
    ext: ".exe",
    archiveExt: ".zip",
    binaryPath: "node.exe",
  },
};

if (args.list) {
  console.log("Available targets:");
  for (const [key, t] of Object.entries(TARGETS)) {
    const archiveExt = t.archiveExt ?? ".tar.gz";
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${t.nodeTriple}${archiveExt}`;
    console.log(`  ${key.padEnd(16)} → ${url}`);
  }
  process.exit(0);
}

// ── Resolve target ────────────────────────────────────────────────────────────
const platform = args.platform ?? process.platform;
const arch = args.arch ?? (process.arch === "arm64" ? "arm64" : "x64");
const key = `${platform}-${arch}`;
const target = TARGETS[key];

if (!target) {
  console.error(`Unsupported target: ${key}`);
  console.error("Use --list to see available targets.");
  process.exit(1);
}

const binariesDir = path.join(__dirname, "..", "src-tauri", "binaries");
const destName = `node-${target.tauriTriple}${target.ext}`;
const destPath = path.join(binariesDir, destName);
const versionMarkerPath = `${destPath}.version`;

function readNativeBinaryVersion() {
  if (platform !== process.platform || arch !== process.arch) return null;
  try {
    return execFileSync(destPath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().replace(/^v/, "");
  } catch {
    return "";
  }
}

// ── Check if already downloaded ───────────────────────────────────────────────
const installedVersion = fs.existsSync(versionMarkerPath)
  ? fs.readFileSync(versionMarkerPath, "utf8").trim()
  : "";
const executableVersion = fs.existsSync(destPath) ? readNativeBinaryVersion() : "";
const executableVerified = executableVersion === null || executableVersion === NODE_VERSION;
if (fs.existsSync(destPath) && installedVersion === NODE_VERSION && executableVerified) {
  console.log(`✅ Binary already exists: ${destPath}`);
  console.log(`   Verified version: v${NODE_VERSION}`);
  process.exit(0);
}
if (fs.existsSync(destPath)) {
  console.log(`♻️  Replacing stale or unverified Node binary: ${destPath}`);
}
fs.rmSync(versionMarkerPath, { force: true });

// ── Download & extract ────────────────────────────────────────────────────────
const archiveExt = target.archiveExt ?? ".tar.gz";
const archiveName = `node-v${NODE_VERSION}-${target.nodeTriple}${archiveExt}`;
const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
const checksumsUrl = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`;

console.log(`⬇  Downloading Node.js ${NODE_VERSION} for ${key}...`);
console.log(`   ${url}`);

// Download to temp file
const tmpArchive = path.join(binariesDir, archiveName);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = https.get(url, (response) => {
      response.setTimeout(NETWORK_IDLE_TIMEOUT_MS, () => {
        response.destroy(new Error(`Download stalled for ${NETWORK_IDLE_TIMEOUT_MS}ms: ${url}`));
      });
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        return download(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const total = parseInt(response.headers["content-length"], 10);
      let downloaded = 0;
      response.on("data", (chunk) => {
        downloaded += chunk.length;
        if (total) process.stdout.write(`\r   ${((downloaded / total) * 100).toFixed(1)}%`);
      });
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        process.stdout.write("\r   Done!          \n");
        resolve();
      });
      file.on("error", reject);
    });
    request.setTimeout(NETWORK_IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error(`Connection timed out after ${NETWORK_IDLE_TIMEOUT_MS}ms: ${url}`));
    });
    request.on("error", reject);
  });
}

function downloadText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      response.setTimeout(NETWORK_IDLE_TIMEOUT_MS, () => {
        response.destroy(new Error(`Download stalled for ${NETWORK_IDLE_TIMEOUT_MS}ms: ${url}`));
      });
      if (response.statusCode === 302 || response.statusCode === 301) {
        return downloadText(response.headers.location).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} while downloading ${url}`));
        return;
      }
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(body));
      response.on("error", reject);
    });
    request.setTimeout(NETWORK_IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error(`Connection timed out after ${NETWORK_IDLE_TIMEOUT_MS}ms: ${url}`));
    });
    request.on("error", reject);
  });
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
    input.on("error", reject);
  });
}

fs.mkdirSync(binariesDir, { recursive: true });

Promise.all([download(url, tmpArchive), downloadText(checksumsUrl)])
  .then(async ([, checksums]) => {
    const checksumLine = checksums
      .split(/\r?\n/)
      .find((line) => line.trim().endsWith(`  ${archiveName}`));
    if (!checksumLine) throw new Error(`Missing checksum for ${archiveName}`);
    const expected = checksumLine.trim().split(/\s+/)[0].toLowerCase();
    const actual = await sha256(tmpArchive);
    if (actual !== expected) {
      throw new Error(`SHA-256 mismatch for ${archiveName}: expected ${expected}, got ${actual}`);
    }
    console.log(`🔐 SHA-256 verified: ${actual}`);

    // Extract
    console.log("📦 Extracting...");
    const extractedDir = `node-v${NODE_VERSION}-${target.nodeTriple}`;
    if (archiveExt === ".zip") {
      execSync(`powershell -NoProfile -Command "Expand-Archive -Force '${archiveName}' '.'"`, {
        cwd: binariesDir,
        stdio: "inherit",
      });
    } else {
      execSync(`tar -xzf "${archiveName}"`, { cwd: binariesDir, stdio: "inherit" });
    }

    // Move binary into place
    const extractedBin = path.join(
      binariesDir,
      extractedDir,
      target.binaryPath ?? path.join("bin", `node${target.ext}`)
    );
    fs.rmSync(destPath, { force: true });
    fs.renameSync(extractedBin, destPath);

    // Make executable on Unix
    if (target.ext === "") {
      fs.chmodSync(destPath, 0o755);
    }

    // Older macOS archives may contain a universal binary; current archives
    // are architecture-specific. Only invoke `lipo -thin` for a fat binary.
    if (platform === "darwin") {
      const lipoArch = arch === "arm64" ? "arm64" : "x86_64";
      const binaryArchs = execFileSync("lipo", ["-archs", destPath], {
        encoding: "utf8",
      }).trim().split(/\s+/);
      if (!binaryArchs.includes(lipoArch)) {
        throw new Error(`Downloaded Node architecture is ${binaryArchs.join(", ")}, expected ${lipoArch}`);
      }
      if (binaryArchs.length > 1) {
        const before = fs.statSync(destPath).size;
        const thinned = `${destPath}.thin`;
        execFileSync("lipo", ["-thin", lipoArch, destPath, "-output", thinned], {
          stdio: "inherit",
        });
        fs.renameSync(thinned, destPath);
        fs.chmodSync(destPath, 0o755);
        const after = fs.statSync(destPath).size;
        console.log(
          `🔪 Stripped universal binary to ${lipoArch}: ` +
            `${(before / 1024 / 1024).toFixed(0)}M → ${(after / 1024 / 1024).toFixed(0)}M`
        );
      } else {
        console.log(`   Verified architecture: ${lipoArch}`);
      }
    }

    const extractedVersion = readNativeBinaryVersion();
    if (extractedVersion !== null && extractedVersion !== NODE_VERSION) {
      throw new Error(`Extracted Node version is v${extractedVersion || "unknown"}, expected v${NODE_VERSION}`);
    }

    fs.writeFileSync(versionMarkerPath, `${NODE_VERSION}\n`, "utf8");

    // Cleanup
    fs.rmSync(path.join(binariesDir, extractedDir), { recursive: true, force: true });
    fs.unlinkSync(tmpArchive);

    console.log(`✅ Binary saved as: ${destPath}`);
  })
  .catch((err) => {
    console.error(`❌ Failed: ${err.message}`);
    // Never leave an unverified binary or marker available to the next build.
    try { fs.unlinkSync(tmpArchive); } catch {}
    try { fs.rmSync(versionMarkerPath, { force: true }); } catch {}
    try { fs.rmSync(destPath, { force: true }); } catch {}
    try { fs.rmSync(`${destPath}.thin`, { force: true }); } catch {}
    try { fs.rmSync(path.join(binariesDir, extractedDir), { recursive: true, force: true }); } catch {}
    process.exit(1);
  });
