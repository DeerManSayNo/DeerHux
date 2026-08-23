#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const url = process.env.DEERHUX_DIAGNOSTICS_URL ?? "http://127.0.0.1:30141/api/runtime/diagnostics";
const intervalMs = positiveInt(process.env.DEERHUX_SOAK_INTERVAL_MS, 30_000);
const durationMs = positiveInt(process.env.DEERHUX_SOAK_DURATION_MS, 2 * 60 * 60_000);
const output = process.env.DEERHUX_SOAK_OUTPUT
  ?? path.join(process.cwd(), "tmp", `runtime-soak-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, "", "utf8");

const startedAt = Date.now();
const samples = [];
console.log(`Monitoring ${url} every ${intervalMs}ms for ${durationMs}ms`);
console.log(`Writing samples to ${output}`);

while (Date.now() - startedAt < durationMs) {
  const sampledAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(intervalMs, 10_000)) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const diagnostics = await response.json();
    const sample = { sampledAt, ok: true, diagnostics };
    samples.push(sample);
    await appendFile(output, `${JSON.stringify(sample)}\n`, "utf8");
    console.log(formatLine(sample));
  } catch (error) {
    const sample = { sampledAt, ok: false, error: error instanceof Error ? error.message : String(error) };
    samples.push(sample);
    await appendFile(output, `${JSON.stringify(sample)}\n`, "utf8");
    console.error(`${new Date(sampledAt).toISOString()} ERROR ${sample.error}`);
  }
  const remaining = durationMs - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
}

const valid = samples.filter((sample) => sample.ok).map((sample) => sample.diagnostics);
const summary = valid.length ? {
  samples: samples.length,
  successfulSamples: valid.length,
  failedSamples: samples.length - valid.length,
  output,
  heapUsed: range(valid, (item) => item.process.heapUsed),
  rss: range(valid, (item) => item.process.rss),
  eventLoopP95Ms: range(valid, (item) => item.eventLoop.p95LagMs),
  journalBytes: range(valid, (item) => item.journal.globalRetainedBytes),
  sessionCacheBytes: range(valid, (item) => item.sessionCache.estimatedBytes),
  activeSseConnections: range(valid, (item) => item.transport.activeSseConnections),
  resumedConnections: delta(valid, (item) => item.transport.resumedConnectionsTotal),
  snapshotRequired: delta(valid, (item) => item.transport.snapshotRequiredTotal),
  replayEvents: delta(valid, (item) => item.transport.replayEventsTotal),
  slowConsumerDrops: delta(valid, (item) => item.transport.slowConsumerDrops),
  journalEvictions: delta(valid, (item) => item.journal.evictions?.global?.total),
  activeMcpProcesses: range(valid, (item) => item.mcp.activeProcesses),
  wrappers: range(valid, (item) => item.sessions.wrappers),
} : { samples: samples.length, successfulSamples: 0, failedSamples: samples.length, output };
console.log(JSON.stringify(summary, null, 2));

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function range(values, selector) {
  const numbers = values.map(selector).filter(Number.isFinite);
  return {
    first: numbers[0] ?? 0,
    last: numbers.at(-1) ?? 0,
    min: numbers.length ? Math.min(...numbers) : 0,
    max: numbers.length ? Math.max(...numbers) : 0,
  };
}

function delta(values, selector) {
  const numbers = values.map(selector).filter(Number.isFinite);
  let increase = 0;
  for (let index = 1; index < numbers.length; index += 1) {
    increase += numbers[index] >= numbers[index - 1]
      ? numbers[index] - numbers[index - 1]
      : numbers[index]; // Counter reset after HMR/process restart.
  }
  return { ...range(values, selector), delta: increase };
}

function formatLine(sample) {
  const d = sample.diagnostics;
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  return [
    new Date(sample.sampledAt).toISOString(),
    `heap=${mb(d.process.heapUsed)}MB`,
    `rss=${mb(d.process.rss)}MB`,
    `lagP95=${d.eventLoop.p95LagMs}ms`,
    `journal=${mb(d.journal.globalRetainedBytes)}MB`,
    `cache=${mb(d.sessionCache.estimatedBytes)}MB`,
    `wrappers=${d.sessions.wrappers}`,
    `sse=${d.transport.activeSseConnections}`,
    `resume=${d.transport.resumedConnectionsTotal ?? 0}`,
    `snapshot=${d.transport.snapshotRequiredTotal ?? 0}`,
    `evicted=${d.journal.evictions?.global?.total ?? 0}`,
    `slow=${d.transport.slowConsumerDrops ?? 0}`,
    `mcp=${d.mcp.activeProcesses}`,
  ].join(" ");
}
