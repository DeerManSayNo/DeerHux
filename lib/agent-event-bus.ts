/**
 * Simple typed event emitter for agent events.
 * Used to decouple the SSE event source from the log panel.
 */
import type { AgentRuntimeEventBase } from "./agent-runtime/types";

/** 兼容名称；事件基础契约统一由 agent-runtime/types 提供。 */
export type AgentEvent = AgentRuntimeEventBase;

type Listener = (event: AgentEvent) => void;

class AgentEventBus {
  private listeners: Set<Listener> = new Set();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore
      }
    }
  }
}

const globalForBus = globalThis as unknown as { __deerhuxAgentEventBus?: AgentEventBus };
if (!globalForBus.__deerhuxAgentEventBus) {
  globalForBus.__deerhuxAgentEventBus = new AgentEventBus();
}

export const agentEventBus = globalForBus.__deerhuxAgentEventBus;
