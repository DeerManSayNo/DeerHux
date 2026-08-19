/**
 * Typed, session-scoped event emitter for agent events.
 * Used to decouple the SSE event source from session-specific UI effects.
 */
import type { AgentRuntimeEventBase } from "./agent-runtime/types";

/** 兼容名称；事件基础契约统一由 agent-runtime/types 提供。 */
export type AgentEvent = AgentRuntimeEventBase;

/** 每个 UI 事件都必须保留来源会话，避免多窗口间串扰。 */
export interface AgentEventEnvelope {
  sessionId: string;
  event: AgentEvent;
}

type Listener = (envelope: AgentEventEnvelope) => void;

export class AgentEventBus {
  private listenersBySession = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener): () => void {
    let listeners = this.listenersBySession.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.listenersBySession.set(sessionId, listeners);
    }
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listenersBySession.delete(sessionId);
    };
  }

  emit(envelope: AgentEventEnvelope): void {
    const listeners = this.listenersBySession.get(envelope.sessionId);
    if (!listeners) return;

    for (const listener of listeners) {
      try {
        listener(envelope);
      } catch {
        // 一个 UI 副作用失败不能阻断同会话的其他监听器。
      }
    }
  }
}

const BUS_VERSION = 2;
const globalForBus = globalThis as unknown as {
  __deerhuxAgentEventBus?: AgentEventBus;
  __deerhuxAgentEventBusVersion?: number;
};
if (globalForBus.__deerhuxAgentEventBusVersion !== BUS_VERSION) {
  globalForBus.__deerhuxAgentEventBus = new AgentEventBus();
  globalForBus.__deerhuxAgentEventBusVersion = BUS_VERSION;
}

export const agentEventBus = globalForBus.__deerhuxAgentEventBus!;
