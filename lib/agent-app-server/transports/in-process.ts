/**
 * In-process transport for the RpcBroker.
 *
 * Provides a pair of connected endpoints — a {@link RpcTransportConnection}
 * the broker attaches to, and an {@link InProcessClient} used by tests or
 * other in-process callers — backed by two in-memory listener arrays.
 *
 * No network, no serialization: envelopes are passed by reference. This keeps
 * unit tests fast and makes admission/handshake behaviour deterministic.
 */
import type { RpcTransportConnection } from "../broker.ts";
import type { ClientEnvelope, ServerEnvelope } from "../protocol.ts";

export interface InProcessClient {
  readonly id: string;
  send(message: ClientEnvelope): void;
  onMessage(listener: (message: ServerEnvelope) => void): () => void;
  onClose(listener: (reason?: unknown) => void): () => void;
  close(code?: number, reason?: string): void;
}

export interface InProcessTransportPair {
  /** Endpoint handed to {@link RpcBroker.handleConnection}. */
  server: RpcTransportConnection;
  /** Endpoint used by tests / in-process callers. */
  client: InProcessClient;
}

type MessageListener<S> = (message: S) => void;
type CloseListener = (reason?: unknown) => void;

function createEmitter<L>() {
  const listeners = new Set<L>();
  return {
    on(listener: L): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(listener: (l: L) => void): void {
      for (const l of listeners) listener(l);
    },
    clear(): void {
      listeners.clear();
    },
  };
}

/**
 * Create a connected in-process transport pair. Messages sent on one end are
 * delivered synchronously to the other end's `onMessage` listeners.
 */
export function createInProcessTransport(idHint = "in-process"): InProcessTransportPair {
  const id = `${idHint}-${Math.random().toString(36).slice(2, 10)}`;

  // server-side: receives ClientEnvelope from client, emits ServerEnvelope to client
  const serverInbound = createEmitter<MessageListener<ClientEnvelope>>();
  const serverClose = createEmitter<CloseListener>();

  // client-side: receives ServerEnvelope from server, emits ClientEnvelope to server
  const clientInbound = createEmitter<MessageListener<ServerEnvelope>>();
  const clientClose = createEmitter<CloseListener>();

  let serverClosed = false;
  let clientClosed = false;

  const server: RpcTransportConnection = {
    id,
    send(message: ServerEnvelope): void {
      if (serverClosed) return;
      clientInbound.emit((l) => l(message));
    },
    onMessage(listener: MessageListener<ClientEnvelope>): () => void {
      return serverInbound.on(listener);
    },
    onClose(listener: CloseListener): () => void {
      return serverClose.on(listener);
    },
    close(code?: number, reason?: string): void {
      if (serverClosed && clientClosed) return;
      serverClosed = true;
      clientClosed = true;
      serverClose.emit((l) => l({ code, reason }));
      clientClose.emit((l) => l({ code, reason }));
      serverInbound.clear();
      clientInbound.clear();
      serverClose.clear();
      clientClose.clear();
    },
  };

  const client: InProcessClient = {
    id,
    send(message: ClientEnvelope): void {
      if (clientClosed) return;
      serverInbound.emit((l) => l(message));
    },
    onMessage(listener: MessageListener<ServerEnvelope>): () => void {
      return clientInbound.on(listener);
    },
    onClose(listener: CloseListener): () => void {
      return clientClose.on(listener);
    },
    close(code?: number, reason?: string): void {
      if (serverClosed && clientClosed) return;
      serverClosed = true;
      clientClosed = true;
      clientClose.emit((l) => l({ code, reason }));
      serverClose.emit((l) => l({ code, reason }));
      serverInbound.clear();
      clientInbound.clear();
      serverClose.clear();
      clientClose.clear();
    },
  };

  return { server, client };
}
