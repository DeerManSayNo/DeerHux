export interface TransportDiagnostics {
  activeSseConnections: number;
  openedSseConnections: number;
  closedSseConnections: number;
  slowConsumerDrops: number;
}

declare global {
  var __deerhuxTransportDiagnostics: TransportDiagnostics | undefined;
}

function state(): TransportDiagnostics {
  return globalThis.__deerhuxTransportDiagnostics ??= {
    activeSseConnections: 0,
    openedSseConnections: 0,
    closedSseConnections: 0,
    slowConsumerDrops: 0,
  };
}

export function openSseConnection(): () => void {
  const metrics = state();
  metrics.activeSseConnections += 1;
  metrics.openedSseConnections += 1;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    metrics.activeSseConnections = Math.max(0, metrics.activeSseConnections - 1);
    metrics.closedSseConnections += 1;
  };
}

export function recordSlowConsumerDrop(): void {
  state().slowConsumerDrops += 1;
}

export function getTransportDiagnostics(): TransportDiagnostics {
  return { ...state() };
}
