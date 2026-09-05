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
const browserCandidates = [process.env.SUBAGENT_TEST_BROWSER, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].filter(Boolean);
const browserPath = browserCandidates.find((candidate) => fs.existsSync(candidate));
if (!browserPath) throw new Error("A local Chromium browser is required; set SUBAGENT_TEST_BROWSER. No browser will be downloaded.");
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
    entry: path.join(root, "scripts/fixtures/subagent-review-ui.tsx"),
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
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--bg:#10141c;--bg-hover:#171e29;--bg-panel:#131b26;--text:#e7edf5;--text-dim:#a0acbf;--border:#344155;--accent:#8baaff;--danger:#f87171}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Arial,sans-serif}button,input,textarea{font:inherit}button{color:inherit}button:focus-visible,input:focus-visible{outline:2px solid #93c5fd;outline-offset:2px}a{color:#93c5fd}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`;
  server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); fs.createReadStream(path.join(temporary, "fixture.js")).pipe(response); }
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
  await waitFor("!!window.uiFixture && document.body.innerText.includes('同名 Worker')", "fixture mounted");
  assert.equal(await evaluate("window.uiFixture.requests.length"), 0, "mount must not eagerly load artifact bodies");
  await screenshot("desktop-card.png");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot("mobile-card.png");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "card must not overflow the mobile viewport");

  if (!process.argv.includes("--smoke")) {
    await runInteractionTests({ evaluate, waitFor, cdp, screenshot });
  }
  assert.deepEqual(browserErrors, [], "browser must not throw runtime errors");
  console.log(`subagent review browser tests passed (${process.argv.includes("--smoke") ? "smoke" : "interactive"})`);
  if (keep) console.log(`Browser screenshots: ${temporary}`);
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) { browser.kill("SIGTERM"); await Promise.race([new Promise((resolve) => browser.once("exit", resolve)), sleep(3_000)]); }
  if (server) await new Promise((resolve) => server.close(resolve));
  if (!keep) fs.rmSync(temporary, { recursive: true, force: true });
}

async function runInteractionTests({ evaluate, waitFor, cdp, screenshot }) {
  const selector = (label) => `[aria-label=${JSON.stringify(label)}]`;
  const findButton = (label) => `([...(document.querySelector('dialog[open]') ?? document).querySelectorAll('button')].find(button => button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.textContent.trim() === ${JSON.stringify(label)}))`;
  const click = async (label) => {
    await waitFor(`${findButton(label)} && !${findButton(label)}.disabled`, `enabled button ${label}`);
    const point = await evaluate(`(() => { const button = ${findButton(label)}; button.scrollIntoView({block:'center'}); const box = button.getBoundingClientRect(); const x = box.left + box.width / 2, y = box.top + box.height / 2; if (!button.contains(document.elementFromPoint(x,y))) throw new Error('Button is not reachable: ' + ${JSON.stringify(label)}); return {x,y}; })()`);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  };
  const reset = async (options = {}) => {
    await waitFor("!document.querySelector('dialog[aria-busy=true]')", "previous operation settled before test reset");
    const generation = await evaluate("document.querySelector('main').dataset.fixtureGeneration");
    await evaluate(`window.uiFixture.reset(${JSON.stringify(options)})`);
    await waitFor(`document.querySelector('main').dataset.fixtureGeneration !== ${JSON.stringify(generation)}`, "fixture reset committed");
    await waitFor("!document.querySelector('dialog[open], [role=dialog]')", "previous dialog unmounted");
  };
  const openReview = async () => {
    await click("审阅成果");
    await waitFor("!!document.querySelector('dialog[open], [role=dialog]')", "review dialog visible");
  };
  const chooseWorker = async (index) => {
    await waitFor(`document.querySelectorAll('input[aria-label^="选择 Worker"]').length > ${index}`, "Worker selection available");
    await evaluate(`document.querySelectorAll('[aria-label="Worker 列表"] button')[${index}].click()`);
    await waitFor(`!document.querySelectorAll('input[aria-label^="选择 Worker"]')[${index}].disabled`, "Worker summary loaded");
    await evaluate(`{ const checkbox = document.querySelectorAll('input[aria-label^="选择 Worker"]')[${index}]; if (!checkbox.checked) checkbox.click(); }`);
  };
  const chooseFile = async (file) => {
    const query = `document.querySelector(${JSON.stringify(selector(`选择文件 ${file}`))})`;
    await waitFor(`!!${query}`, `file ${file} loaded`);
    await evaluate(`for (const other of document.querySelectorAll('input[aria-label^="选择文件 "]')) { if (other !== ${query} && other.checked) other.click(); }`);
    await evaluate(`if (!${query}.checked) ${query}.click()`);
  };
  const fileChecked = (file) => `document.querySelector(${JSON.stringify(selector(`选择文件 ${file}`))})?.checked === true`;
  const applyCount = "window.uiFixture.requests.filter(request => request.path.endsWith('/apply')).length";
  const key = async (value, modifiers = 0) => {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: value, code: value, windowsVirtualKeyCode: value === "Tab" ? 9 : 27, modifiers });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: value, code: value, windowsVirtualKeyCode: value === "Tab" ? 9 : 27, modifiers });
  };

  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await reset({ metadataMode: "legacy" }); await openReview(); await chooseWorker(0);
  assert.equal(await evaluate("document.querySelector('dialog[open]').innerText.includes('变更类型未知 · 二进制 · 大小未知') && document.querySelector('main').innerText.includes('增删统计未知')"), true, "historical captures do not invent metadata");
  await reset({ metadataMode: "typechange" }); await openReview(); await chooseWorker(0);
  assert.equal(await evaluate("document.querySelector('dialog[open]').innerText.includes('⇄ 类型变更 · 文本')"), true);
  await reset(); await openReview(); await chooseWorker(0); await chooseFile("src/alpha.ts");
  assert.equal(await evaluate("document.querySelector('dialog[open]').innerText.includes('− 删除 · 二进制 · 删除前 4,096 B → 已删除')"), true, "binary deletion shows its captured old-side size and explicit deletion label");
  assert.equal(await evaluate("document.querySelector('dialog[open]').innerText.includes('✎ 修改 · 文本 · 旧 12 B → 新 16 B')"), true);
  assert.equal(await evaluate("document.querySelector('main').innerText.includes('新建 0 / 修改 1 / 删除 1 / 重命名 0 / 类型变更 0 · 文本 +1/−1 行')"), true, "Worker card uses structured totals, excluding binary line counts");
  await chooseWorker(1); await chooseFile("src/beta.ts");
  assert.equal(await evaluate("document.querySelector('dialog[open]').innerText.includes('＋ 新建 · 文本 · 新增 16 B')"), true);
  assert.equal(await evaluate("document.querySelector('dialog[open]').innerText.includes('↪ 重命名') && document.querySelector('dialog[open]').innerText.includes('src/old-name.ts →')"), true);
  assert.equal(await evaluate("window.uiFixture.requests.some(request => request.path.includes('format=patch'))"), false, "selection only loads summaries");
  await screenshot("desktop-review.png");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot("mobile-review.png");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "review must fit narrow viewport");
  await evaluate(`window.uiFixture.configure({delayMs:400})`);
  await click("应用所选文件");
  await evaluate(`${findButton("应用所选文件")}?.click()`);
  await waitFor("document.querySelector('dialog[open]')?.getAttribute('aria-busy') === 'true'", "Apply enters pending state");
  await key("Escape");
  assert.equal(await evaluate("!!document.querySelector('dialog[open], [role=dialog]')"), true, `Escape cannot close a submission: ${await evaluate("JSON.stringify({requests:window.uiFixture.requests,body:document.body.innerText})")}`);
  await waitFor("window.uiFixture.snapshot().status === 'applied'", "Apply completed");
  assert.equal(await evaluate(applyCount), 1, "double-click must not submit twice");
  const appliedRequest = await evaluate("window.uiFixture.requests.find(request => request.path.endsWith('/apply')).body");
  assert.deepEqual(appliedRequest.workerIds, ["browser_review_worker_1", "browser_review_worker_2"]);
  assert.deepEqual(appliedRequest.files, ["src/alpha.ts", "src/beta.ts"]);
  await waitFor("window.uiFixture.updateSnapshots.some(run => run.status === 'applied')", "UI receives authoritative applied snapshot");

  await reset({ outcome: "conflict" }); await openReview(); await chooseWorker(0); await chooseFile("src/alpha.ts");
  await click("应用所选文件");
  await waitFor(`${applyCount} === 1 && !${findButton("应用所选文件")}.disabled`, "conflict settled");
  assert.equal(await evaluate(fileChecked("src/alpha.ts")), true, "conflict retains selection");
  assert.equal(await evaluate("window.uiFixture.snapshot().status"), "complete");
  await evaluate("window.uiFixture.configure({outcome:'applied'})"); await click("应用所选文件");
  await waitFor("window.uiFixture.snapshot().status === 'applied'", "conflict retry completed");

  for (const outcome of ["precondition_failed", "error", "no_changes"]) {
    await reset({ outcome }); await openReview(); await chooseWorker(0); await chooseFile("src/alpha.ts"); await click("应用所选文件");
    await waitFor(`${applyCount} === 1 && !${findButton("应用所选文件")}.disabled`, `${outcome} settled`);
    assert.equal(await evaluate("window.uiFixture.updateSnapshots.some(run => run.status === 'applied')"), false, `${outcome} cannot claim applied`);
  }
  await reset({ outcome: "offline_applied" }); await openReview(); await chooseWorker(0); await chooseFile("src/alpha.ts"); await click("应用所选文件");
  await waitFor(`${applyCount} === 1`, "disconnected Apply reached server");
  await waitFor("document.querySelector('dialog[open]')?.getAttribute('aria-busy') === 'false'", "disconnected request settled");
  await key("Escape"); await waitFor("!document.querySelector('dialog[open]')", "close review to reach verification toolbar");
  await click("核验上次应用");
  await waitFor("window.uiFixture.updateSnapshots.some(run => run.status === 'applied')", "lost response resolved from server facts");
  assert.equal(await evaluate(applyCount), 1, "verified applied request must not be replayed");
  await reset({ outcome: "offline" }); await openReview(); await chooseWorker(0); await chooseFile("src/alpha.ts"); await click("应用所选文件");
  await waitFor(`${applyCount} === 1 && document.querySelector('dialog[open]')?.getAttribute('aria-busy') === 'false'`, "offline request remains unresolved");
  const originalRequest = await evaluate("window.uiFixture.requests.find(request => request.path.endsWith('/apply')).body");
  await key("Escape"); await waitFor("!document.querySelector('dialog[open]')", "offline dialog closes before verification");
  await evaluate("window.uiFixture.configure({outcome:'applied'})"); await click("核验上次应用");
  await waitFor("window.uiFixture.updateSnapshots.some(run => run.status === 'applied')", "unchanged server safely replays original request");
  assert.deepEqual(await evaluate("window.uiFixture.requests.filter(request => request.path.endsWith('/apply'))[1].body"), originalRequest, "network retry preserves exact key and payload");

  await reset(); await openReview(); await chooseWorker(0); await chooseFile("src/alpha.ts");
  await key("Escape"); await waitFor("!document.querySelector('dialog[open], [role=dialog]')", "Escape closes idle dialog");
  await openReview(); await waitFor(fileChecked("src/alpha.ts"), "reopening retains selection after summary reload");
  await evaluate("window.uiFixture.advanceVersion()");
  await waitFor(`!(${fileChecked("src/alpha.ts")})`, "version change invalidates selection");
  await chooseWorker(0); await chooseFile("src/alpha.ts");
  await evaluate("window.uiFixture.replaceCaptureSameVersion()");
  await waitFor(`!(${fileChecked("src/alpha.ts")})`, "same-version digest change invalidates selection");
  // A remounted capture is already empty; selecting then clearing verifies the command.
  await key("Escape"); await reset(); await openReview(); await chooseWorker(0); await chooseFile("src/alpha.ts");
  await click("清空选择");
  assert.equal(await evaluate(`${findButton("应用所选文件")}.disabled`), true, "empty selection cannot Apply");

  // A previously fetched same-version snapshot must not hide newly recovered props.
  await key("Escape"); await click("刷新状态");
  await waitFor("window.uiFixture.updateSnapshots.length > 0", "fresh detail snapshot received");
  await openReview(); await chooseWorker(0); await chooseFile("src/alpha.ts");
  await evaluate("window.uiFixture.replaceCaptureSameVersion()");
  await waitFor(`!(${fileChecked("src/alpha.ts")})`, "fresh props win equal-version/equal-time local cache");

  // Native dialog keyboard behavior, including full cyclic focus and restoration.
  await reset(); await openReview(); await chooseWorker(0);
  const focusables = `Array.from(document.querySelector('dialog[open]').querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')).filter(element => element.getClientRects().length > 0)`;
  await evaluate(`{ const items = ${focusables}; items[items.length - 1].focus(); }`);
  await key("Tab"); assert.equal(await evaluate(`document.activeElement === (${focusables})[0]`), true, "Tab wraps to first focusable");
  await key("Tab", 8); assert.equal(await evaluate(`document.activeElement === (${focusables}).at(-1)`), true, "Shift+Tab wraps to last focusable");
  await key("Escape"); await waitFor("!document.querySelector('dialog[open]')", "idle Escape closes");

  // Reopening keeps both Workers' metadata available to global selection commands.
  await openReview(); await chooseWorker(0); await chooseFile("src/alpha.ts"); await chooseWorker(1); await chooseFile("src/beta.ts");
  await key("Escape"); await openReview();
  await waitFor("document.querySelectorAll('input[aria-label^=" + JSON.stringify("选择 Worker") + "]:checked').length === 2", "both Worker selections restored");
  await click("全选文件");
  await waitFor("document.querySelector('dialog[open]').innerText.includes('4 个路径')", "global select-all after reopen includes inactive Worker files");
  await reset(); await openReview(); await click("审阅全部成果");
  await waitFor("document.querySelector('dialog[open]').innerText.includes('4 个路径')", "explicit review-all loads and selects all captured files");
  assert.equal(await evaluate(applyCount), 0, "review-all is not implicit Apply");

  // Text is on demand. Binary and oversize artifacts never enter the inline renderer.
  await reset(); await openReview(); await chooseWorker(0);
  assert.equal(await evaluate(`${findButton("加载 unified diff")} === undefined`), true, "binary artifact offers download only");
  await chooseWorker(1); await click("加载 unified diff");
  await waitFor("!!document.querySelector('[aria-label=" + JSON.stringify("Unified diff 正文") + "]')", "text patch is rendered on demand");
  assert.equal(await evaluate("window.uiFixture.requests.filter(request => request.path.includes('format=patch')).length"), 1);
  await reset({ largePatch: true }); await openReview(); await chooseWorker(1);
  assert.equal(await evaluate(`${findButton("加载 unified diff")} === undefined`), true, "large artifact offers download only");
  assert.equal(await evaluate("window.uiFixture.requests.some(request => request.path.includes('format=patch'))"), false);
  await reset({ sharedPath: true }); await openReview(); await chooseWorker(0); await chooseWorker(1);
  await waitFor("document.querySelector('dialog[open]').innerText.includes('同一路径')", "cross-Worker overlap warning is shown");

  await reset({ outcome: "recovery_required" }); await openReview(); await chooseWorker(0); await chooseFile("src/alpha.ts"); await click("应用所选文件");
  await waitFor("window.uiFixture.snapshot().status === 'recoverable' && document.querySelector('dialog[open]')?.getAttribute('aria-busy') === 'false'", "recovery response settled");
  assert.equal(await evaluate(`${findButton("应用所选文件")}.disabled`), true, "recovery blocks Apply");
  assert.equal(await evaluate("[...document.querySelectorAll('button[aria-label^=" + JSON.stringify("继续 Worker") + "]')].every(button => button.disabled)"), true, "recovery blocks Continue");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(button => button.textContent.trim() === '核验上次应用')"), false, "manual recovery has no one-click retry");

  await reset();
  await evaluate("document.querySelector('button[aria-label^=" + JSON.stringify("继续 Worker") + "]').click()");
  await waitFor("document.querySelector('dialog[open]')?.innerText.includes('确认继续')", "Continue confirmation visible");
  await click("确认继续");
  await waitFor("window.uiFixture.requests.some(request => request.path.endsWith('/workers/browser_review_worker_1/resume'))", "Continue uses stable Worker ID");
  await waitFor("!document.querySelector('dialog[open]')", "Continue completed");
  await reset({ ttlMs: 150 });
  await waitFor("window.uiFixture.requests.some(request => request.path === '/api/agent-runs/browser_review_run') && window.uiFixture.snapshot().canContinue === false", "TTL expiration refreshes actual server state");
  await waitFor("[...document.querySelectorAll('button[aria-label^=" + JSON.stringify("继续 Worker") + "]')].every(button => button.disabled)", "expired Continue disabled");

  await reset({ discardStrong: true, discardPartial: true }); await click("放弃成果"); await click("预览放弃影响");
  await waitFor("!!document.querySelector('[aria-label=" + JSON.stringify("高风险放弃确认文本") + "]')", "strong confirmation required");
  assert.equal(await evaluate(`${findButton("确认风险并重新预览")}.disabled`), true);
  assert.equal(await evaluate(`${findButton("确认放弃")} === undefined`), true, "no commit token before strong confirmation");
  await evaluate("document.querySelector('[aria-label=" + JSON.stringify("高风险放弃确认文本") + "]').focus()");
  await cdp("Input.insertText", { text: "DISCARD_UNCAPTURED_CHANGES" });
  await click("确认风险并重新预览");
  await waitFor(`!!${findButton("确认放弃")}`, "acknowledged preview returns token");
  assert.equal(await evaluate(`${findButton("确认放弃")}.disabled`), true, "commit also requires ordinary acknowledgment");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await screenshot("desktop-discard.png");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot("mobile-discard.png");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "Discard fits narrow viewport");
  await evaluate("[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('我已了解')).querySelector('input').click()");
  await click("确认放弃");
  await waitFor("document.querySelector('dialog[open]').innerText.includes('部分资源仍保留，清理未全部完成')", "207 partial is not completed");
  assert.equal(await evaluate("window.uiFixture.requests.filter(request => request.path.endsWith('/discard') && request.body.mode === 'commit').length"), 1);
  await screenshot("mobile-discard-partial.png");
  await reset();
  await evaluate("Object.entries({'--bg':'#ffffff','--bg-panel':'#f5f5f5','--bg-hover':'#eeeeee','--border':'#e0e0e0','--text':'#1a1a1a','--text-dim':'#9ca3af','--accent':'#2563eb'}).forEach(([key,value]) => document.documentElement.style.setProperty(key,value))");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await openReview(); await chooseWorker(1); await click("加载 unified diff");
  await waitFor("!!document.querySelector('[aria-label=" + JSON.stringify("Unified diff 正文") + "]')", "light-mode text preview ready");
  await screenshot("desktop-review-light.png");
  console.log("browser interactions: partial Apply, idempotency, failures, recovery, stale selection, keyboard, lazy Diff, Continue TTL and strong/partial Discard passed");
}
