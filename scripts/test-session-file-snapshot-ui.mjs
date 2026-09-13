import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Uses existing local dependencies and an isolated Chromium profile. It does not
// start Next, touch .next, install packages, or contact any external endpoint.
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack");
const WebSocket = require("ws");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserCandidates = [process.env.SNAPSHOT_TEST_BROWSER, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].filter(Boolean);
const browserPath = browserCandidates.find((candidate) => fs.existsSync(candidate));
if (!browserPath) throw new Error("A local Chromium browser is required; set SNAPSHOT_TEST_BROWSER. No browser will be downloaded.");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-ui-browser-"));
const keep = process.argv.includes("--keep");
let browser;
let server;
let socket;
const pending = new Map();
let commandId = 0;
const browserErrors = [];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function cdp(method, params = {}) {
  const id = ++commandId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve: (result) => { clearTimeout(timer); resolve(result); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression, label = expression) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(20);
  }
  throw new Error(`Browser assertion timed out: ${label}\n${await evaluate("document.body.innerText")}`);
}
async function screenshot(name) {
  const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  fs.writeFileSync(path.join(temporary, name), Buffer.from(shot.data, "base64"));
}
async function buildFixture() {
  const compiler = webpack({
    mode: "development", target: "web", devtool: false,
    entry: path.join(root, "scripts/fixtures/session-file-snapshot-ui.tsx"),
    output: { path: temporary, filename: "fixture.js" },
    resolve: { extensions: [".tsx", ".ts", ".mjs", ".js"], alias: { "@": root } },
    module: { rules: [
      { test: /\.tsx?$/, exclude: /node_modules/, use: [{ loader: path.join(root, "scripts/fixtures/typescript-browser-loader.mjs") }] },
      { test: /\.css$/, use: [{ loader: path.join(root, "scripts/fixtures/css-browser-loader.mjs") }] },
    ] },
    optimization: { minimize: false },
  });
  try {
    await new Promise((resolve, reject) => compiler.run((error, stats) => error ? reject(error) : stats.hasErrors() ? reject(new Error(stats.toString({ all: false, errors: true }))) : resolve()));
  } finally {
    await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()));
  }
}
try {
  await buildFixture();
  const stylesheet = path.join(root, "app/globals.css");
  const { css: globalsCss } = await require("postcss")([require("@tailwindcss/postcss")({ base: root })])
    .process(fs.readFileSync(stylesheet, "utf8"), { from: stylesheet });
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--bg:#10141c;--bg-hover:#171e29;--bg-panel:#131b26;--text:#e7edf5;--text-dim:#a0acbf;--border:#344155;--accent:#8baaff;--danger:#f87171}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Arial,sans-serif}button,input,textarea{font:inherit}button{color:inherit}button:focus-visible,input:focus-visible{outline:2px solid #93c5fd;outline-offset:2px}a{color:#93c5fd}${globalsCss}</style></head><body><div id="root"></div><script>globalThis.process={env:{NODE_ENV:"development"}};</script><script src="/fixture.js"></script></body></html>`;
  server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url?.split("?")[0].endsWith(".js")) { response.setHeader("Content-Type", "text/javascript"); const file = path.join(temporary, path.basename(request.url.split("?")[0])); if (fs.existsSync(file)) fs.createReadStream(file).pipe(response); else { response.statusCode = 404; response.end(); } }
    else { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--remote-debugging-port=0", `--user-data-dir=${path.join(temporary, "profile")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const browserEndpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Chromium did not start: ${output}`)), 15_000);
    browser.stderr.on("data", (chunk) => { output += String(chunk); const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    browser.once("error", reject);
    browser.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Chromium exited early: ${code}`)); });
  });
  const debuggerUrl = new URL(browserEndpoint);
  const target = await (await fetch(`http://${debuggerUrl.host}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id && pending.has(message.id)) { const entry = pending.get(message.id); pending.delete(message.id); if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result); }
    if (message.method === "Runtime.exceptionThrown") browserErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  await cdp("Runtime.enable"); await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const kinds = "[...document.querySelectorAll('[data-file-change-kind]')].map(x=>x.dataset.fileChangeKind)";
  await waitFor("window.snapshotFixture && document.querySelectorAll('[data-file-change-kind]').length === 3", 'restored initial snapshot');
  assert.deepEqual(await evaluate(kinds), ['added','modified','deleted']);
  assert.equal(await evaluate('window.snapshotFixture.completions()'),0, 'restoring history must not fire onAgentEnd side effects');
  await screenshot('snapshot-initial.png');
  await evaluate('window.snapshotFixture.close()');
  await waitFor("document.body.innerText.includes('窗口已关闭')");
  await evaluate("window.snapshotFixture.hold(); window.snapshotFixture.open('a')");
  await waitFor("document.querySelectorAll('[data-file-change-kind]').length === 3", 'cached snapshot restores before network');
  assert.deepEqual(await evaluate(kinds), ['added','modified','deleted']);
  await evaluate('window.snapshotFixture.release()');
  await evaluate("window.snapshotFixture.open('b')");
  await waitFor("document.querySelectorAll('[data-file-change-kind]').length === 1 && document.body.innerText.includes('only-b.ts')", 'session B isolation');
  await evaluate("window.snapshotFixture.open('a')");
  await waitFor("document.querySelectorAll('[data-file-change-kind]').length === 3", 'session A restored');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__snapshotReloaded = true;' });
  await cdp('Page.reload', {ignoreCache:true});
  await waitFor('window.__snapshotReloaded === true', 'new document loaded');
  await waitFor("window.snapshotFixture && document.querySelectorAll('[data-file-change-kind]').length === 3", 'page refresh from saved response without client memory');
  await evaluate('window.snapshotFixture.close()');
  await waitFor("document.body.innerText.includes('窗口已关闭')");
  await evaluate("window.snapshotFixture.hold(); window.snapshotFixture.open('a')");
  await waitFor('window.snapshotFixture.pending() > 0');
  assert.equal(await evaluate("document.querySelectorAll('[data-file-change-kind]').length"),3,'cached snapshot stays visible while the request is pending');
  await evaluate("window.snapshotFixture.emit({type:'agent_start'})");
  await waitFor("document.querySelectorAll('[data-file-change-kind]').length === 0", 'new turn clears old snapshot');
  await evaluate(`window.snapshotFixture.emit({type:'agent_end',willRetry:false,stopReason:'aborted',changedFiles:[],fileChanges:[],fileChangeSnapshot:window.snapshotFixture.saveEmpty()})`);
  await evaluate('window.snapshotFixture.release()');
  await waitFor("document.body.innerText.includes('本轮文件已处理完成。')");
  await sleep(150);
  assert.equal(await evaluate("document.querySelectorAll('[data-file-change-kind]').length"),0,'late old snapshot must not resurrect previous files');
  await evaluate('window.snapshotFixture.close()');
  await waitFor("document.body.innerText.includes('窗口已关闭')");
  await evaluate("window.snapshotFixture.open('a')");
  await waitFor("document.body.innerText.includes('本轮文件已处理完成。')");
  assert.equal(await evaluate("document.querySelectorAll('[data-file-change-kind]').length"),0,'reopening empty turn stays empty');
  assert.deepEqual(browserErrors, []);
  console.log('Session snapshot close/reopen, reload, isolation and delayed-response browser tests passed.');
  if (keep) console.log('Screenshots: '+temporary);
} catch (error) { console.error(browserErrors); await screenshot("failed.png"); console.log(temporary, await evaluate("({html:document.body.innerHTML.slice(0,2200), pending:window.snapshotFixture?.pending()})")); throw error; } finally {
  socket?.close();
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),sleep(3000)]); }
  if(server) await new Promise(resolve=>server.close(resolve));
  if (!keep) fs.rmSync(temporary, { recursive: true, force: true });
}
