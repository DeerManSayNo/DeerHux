import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeProviderProxies,
  normalizeProxyUrl,
  withProviderProxy,
  writeProviderProxies,
} from "../lib/provider-proxy.ts";

assert.equal(normalizeProxyUrl("127.0.0.1:7897"), "http://127.0.0.1:7897");
assert.equal(normalizeProxyUrl(" https://localhost:8080/ "), "https://localhost:8080");
assert.equal(normalizeProxyUrl(""), "");
assert.deepEqual(normalizeProviderProxies({ openai: "127.0.0.1:7897", direct: "" }), {
  openai: "http://127.0.0.1:7897",
});
assert.throws(() => normalizeProxyUrl("socks5://127.0.0.1:1080"), /HTTP/);
assert.throws(() => normalizeProxyUrl("http://localhost"), /端口/);
assert.throws(() => normalizeProviderProxies({ openai: 7897 }), /字符串/);

const listen = (server: ReturnType<typeof createServer>) => new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("server did not bind to TCP"));
    resolve(address.port);
  });
});

const tempAgentDir = mkdtempSync(join(tmpdir(), "deerhux-provider-proxy-test-"));
process.env.DEERHUX_CODING_AGENT_DIR = tempAgentDir;
const target = createServer((_req, response) => response.end("through-proxy"));
const proxy = createServer();
let proxyConnections = 0;
proxy.on("connect", (request, clientSocket, head) => {
  proxyConnections += 1;
  const [host, port] = (request.url ?? "").split(":");
  const upstream = connect(Number(port), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
});

try {
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  writeProviderProxies({ test: `http://127.0.0.1:${proxyPort}` });
  const response = await withProviderProxy("test", async () => {
    await Promise.resolve();
    return fetch(`http://127.0.0.1:${targetPort}`);
  });
  assert.equal(await response.text(), "through-proxy");
  assert.equal(proxyConnections, 1);
} finally {
  proxy.closeAllConnections();
  target.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => proxy.close(() => resolve())),
    new Promise<void>((resolve) => target.close(() => resolve())),
  ]);
  rmSync(tempAgentDir, { recursive: true, force: true });
}

console.log("provider proxy tests passed");
