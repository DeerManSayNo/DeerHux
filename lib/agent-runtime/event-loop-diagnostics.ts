export interface EventLoopDiagnostics {
  samples: number;
  lastLagMs: number;
  averageLagMs: number;
  p95LagMs: number;
  maxLagMs: number;
}

interface EventLoopSamplerState {
  values: number[];
  timer?: ReturnType<typeof setTimeout>;
}

declare global {
  var __deerhuxEventLoopSampler: EventLoopSamplerState | undefined;
}

const INTERVAL_MS = 1_000;
const MAX_SAMPLES = 60;

function sampler(): EventLoopSamplerState {
  const state = globalThis.__deerhuxEventLoopSampler ??= { values: [] };
  if (!state.timer) schedule(state);
  return state;
}

function schedule(state: EventLoopSamplerState): void {
  const expectedAt = performance.now() + INTERVAL_MS;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    state.values.push(Math.max(0, performance.now() - expectedAt));
    if (state.values.length > MAX_SAMPLES) state.values.splice(0, state.values.length - MAX_SAMPLES);
    schedule(state);
  }, INTERVAL_MS);
  state.timer.unref?.();
}

export function getEventLoopDiagnostics(): EventLoopDiagnostics {
  const values = sampler().values;
  if (!values.length) {
    return { samples: 0, lastLagMs: 0, averageLagMs: 0, p95LagMs: 0, maxLagMs: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    samples: values.length,
    lastLagMs: round(values[values.length - 1]),
    averageLagMs: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p95LagMs: round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]),
    maxLagMs: round(sorted[sorted.length - 1]),
  };
}
