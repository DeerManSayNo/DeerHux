import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { fetch as undiciFetch, ProxyAgent } from "undici";

export type ProviderProxies = Record<string, string>;

export interface ProxyNodeStatus {
  ip: string;
  country: string;
  countryCode: string;
}

const proxyContext = new AsyncLocalStorage<string>();
const proxyAgents = new Map<string, ProxyAgent>();
let proxyFetchInstalled = false;

export class ProviderProxyConfigError extends Error {}

function configPath(): string {
  return join(getAgentDir(), "provider-proxies.json");
}

export function normalizeProxyUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ProviderProxyConfigError("代理地址格式无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderProxyConfigError("代理仅支持 HTTP 或 HTTPS 协议");
  }
  if (!url.hostname || !url.port) throw new ProviderProxyConfigError("代理地址必须包含主机和端口");
  return url.toString().replace(/\/$/, "");
}

export function readProviderProxies(): ProviderProxies {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([provider, value]) => {
      if (typeof value !== "string" || !value.trim()) return [];
      try {
        return [[provider, normalizeProxyUrl(value)]];
      } catch {
        return [];
      }
    }));
  } catch {
    return {};
  }
}

export function normalizeProviderProxies(input: unknown): ProviderProxies {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    if (input === undefined) return readProviderProxies();
    throw new ProviderProxyConfigError("供应商代理配置必须是对象");
  }

  const proxies: ProviderProxies = {};
  for (const [provider, value] of Object.entries(input)) {
    if (typeof value !== "string") throw new ProviderProxyConfigError(`供应商 ${provider} 的代理地址必须是字符串`);
    const normalized = normalizeProxyUrl(value);
    if (normalized) proxies[provider] = normalized;
  }
  return proxies;
}

export function writeProviderProxies(input: unknown): ProviderProxies {
  const proxies = normalizeProviderProxies(input);
  const path = configPath();
  if (!Object.keys(proxies).length) {
    try { unlinkSync(path); } catch { /* file may not exist */ }
    return proxies;
  }

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(proxies, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best effort cleanup */ }
    throw error;
  }
  return proxies;
}

export function getProviderProxy(provider: string): string | undefined {
  return readProviderProxies()[provider];
}

function installProxyAwareFetch(): void {
  if (proxyFetchInstalled) return;
  const directFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const proxyUrl = proxyContext.getStore();
    if (!proxyUrl) return directFetch(input, init);
    let dispatcher = proxyAgents.get(proxyUrl);
    if (!dispatcher) {
      dispatcher = new ProxyAgent(proxyUrl);
      proxyAgents.set(proxyUrl, dispatcher);
    }
    return undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher } as Parameters<typeof undiciFetch>[1],
    ) as unknown as Promise<Response>;
  }) as typeof globalThis.fetch;
  proxyFetchInstalled = true;
}

export function withProviderProxy<T>(provider: string, task: () => T): T {
  const proxyUrl = getProviderProxy(provider);
  if (!proxyUrl) return task();
  return withProxyUrl(proxyUrl, task);
}

export function withProxyUrl<T>(proxyUrl: string, task: () => T): T {
  installProxyAwareFetch();
  return proxyContext.run(normalizeProxyUrl(proxyUrl), task);
}

export async function probeProxyUrl(proxyUrl: string): Promise<ProxyNodeStatus> {
  const response = await withProxyUrl(proxyUrl, () => fetch("https://ipwho.is/", {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }));
  if (!response.ok) throw new Error(`节点探测失败：HTTP ${response.status}`);
  const data = await response.json() as { success?: boolean; ip?: string; country?: string; country_code?: string; message?: string };
  if (data.success === false || !data.ip) throw new Error(data.message || "节点探测未返回 IP");
  return {
    ip: data.ip,
    country: data.country || data.country_code || "未知地区",
    countryCode: data.country_code || "",
  };
}

export async function probeProviderProxy(provider: string): Promise<ProxyNodeStatus> {
  const proxyUrl = getProviderProxy(provider);
  if (!proxyUrl) throw new Error("该供应商未配置代理");
  return probeProxyUrl(proxyUrl);
}
