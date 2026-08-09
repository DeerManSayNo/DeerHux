/**
 * RpcBroker — transport-neutral application-level Agent RPC broker.
 *
 * Phase 0 skeleton (see docs/agent-app-server-design.md §10 Phase 0):
 * - Owns the `initialize` handshake and per-connection ready state.
 * - Dispatches registered methods as request/response or notification.
 * - Maps every failure to an explicit {@link RpcError} (no fuzzy 500s).
 * - Enforces bounded admission via two lanes (control / normal) with both
 *   global and per-session caps, returning `SERVER_OVERLOADED` on overflow.
 *
 * It intentionally depends only on {@link RpcTransportConnection}; it never
 * imports WebSocket, Next.js, or any existing DeerHux business module, so it
 * can be exercised in-process from tests or bridged to any real transport.
 */
import {
  PROTOCOL_VERSION,
  RPC_ERROR_CODES,
  type RpcErrorCode,
  type RpcParams,
  type RpcRequest,
  type RpcNotification,
  type RpcResponse,
  type RpcError,
  type RpcSuccessResponse,
  type ClientEnvelope,
  type ServerEnvelope,
  type InitializeParams,
  type InitializeResult,
  validateClientEnvelope,
  validateInitializeParams,
  isRpcRequest,
  successResponse,
  errorResponse,
} from "./protocol.ts";

/** A transport-neutral duplex connection the broker drives. See design §8.2. */
export interface RpcTransportConnection {
  readonly id: string;
  send(message: ServerEnvelope): Promise<void> | void;
  onMessage(listener: (message: ClientEnvelope) => void): () => void;
  onClose(listener: (reason?: unknown) => void): () => void;
  close(code?: number, reason?: string): void;
}

export const DEFAULT_LIMITS = {
  maxQueuedCommands: 128,
  maxSessionCommands: 8,
  maxControlCommands: 32,
} as const;

export type Limits = {
  maxQueuedCommands: number;
  maxSessionCommands: number;
  maxControlCommands: number;
};

export type MethodLane = "control" | "normal";

export interface MethodRegistration {
  handler: (params: RpcParams, ctx: RequestContext) => unknown | Promise<unknown>;
  /** Control lane (interrupt/shutdown/ping) is admitted separately. Default "normal". */
  lane?: MethodLane;
  /** Name of the params field holding the threadId/sessionId for per-session admission. */
  sessionIdParam?: string;
}

export interface RequestContext {
  connectionId: string;
  method: string;
  params: RpcParams;
  /** Aborted when the transport connection closes. */
  signal: AbortSignal;
  /** True once `initialize` completed for this connection. */
  initialized: boolean;
}

/**
 * Throw from a method handler to produce a typed RPC error response.
 * Any other thrown value becomes `INTERNAL_ERROR`.
 */
export class RpcMethodError extends Error {
  readonly code: RpcErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: RpcErrorCode,
    message: string,
    opts?: { retryable?: boolean; retryAfterMs?: number; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "RpcMethodError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.retryAfterMs = opts?.retryAfterMs;
    this.details = opts?.details;
  }

  toRpcError(): RpcError {
    const err: RpcError = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.retryAfterMs !== undefined) err.retryAfterMs = this.retryAfterMs;
    if (this.details !== undefined) err.details = this.details;
    return err;
  }
}

/** Result of an initialize resume negotiation. Phase 0 has no journal yet. */
export interface ResumeResolution {
  accepted: boolean;
  replayedThrough?: number;
}

export interface BrokerOptions {
  serverInstance: { instanceId: string; version: string };
  limits?: Partial<Limits>;
  /**
   * Decides whether an `initialize` resume cursor can be honored.
   * Defaults to "not accepted" — Phase 1 injects a real journal-backed resolver.
   */
  resolveResume?: (resume: InitializeParams["resume"]) => ResumeResolution;
  /** Optional structured logger; defaults to console. */
  log?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}

interface ConnectionState {
  initialized: boolean;
  controller: AbortController;
  /** In-flight request ids on this connection, for conflict detection. */
  pending: Set<string>;
  tickets: Set<AdmissionTicket>;
}

interface AdmissionTicket {
  release(): void;
}

const INITIALIZE_METHOD = "initialize";

export class RpcBroker {
  private readonly limits: Limits;
  private readonly resolveResume: (resume: InitializeParams["resume"]) => ResumeResolution;
  private readonly log: NonNullable<BrokerOptions["log"]>;
  private readonly serverInstance: { instanceId: string; version: string };

  private readonly methods = new Map<string, MethodRegistration>();
  private readonly notifications = new Map<string, (params: RpcParams, ctx: RequestContext) => unknown | Promise<unknown>>();

  // Admission counters (broker-global, not per-connection).
  private globalNormalInflight = 0;
  private globalControlInflight = 0;
  private readonly sessionNormalInflight = new Map<string, number>();

  // Per-connection state keyed by connection id.
  private readonly connections = new Map<string, ConnectionState>();

  constructor(options: BrokerOptions) {
    this.serverInstance = options.serverInstance;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.resolveResume = options.resolveResume ?? (() => ({ accepted: false }));
    this.log = options.log ?? console;
  }

  /** Register a request/response method. `initialize` is reserved. */
  registerMethod(method: string, registration: MethodRegistration): void {
    if (method === INITIALIZE_METHOD) {
      throw new Error(`Method "${INITIALIZE_METHOD}" is reserved and cannot be registered`);
    }
    if (this.methods.has(method) || this.notifications.has(method)) {
      throw new Error(`Method "${method}" is already registered`);
    }
    this.methods.set(method, {
      lane: registration.lane ?? "normal",
      sessionIdParam: registration.sessionIdParam,
      handler: registration.handler,
    });
  }

  /** Register a fire-and-forget notification (no id, no response). */
  registerNotification(method: string, handler: (params: RpcParams, ctx: RequestContext) => unknown | Promise<unknown>): void {
    if (method === INITIALIZE_METHOD) {
      throw new Error(`Method "${INITIALIZE_METHOD}" is reserved and cannot be registered`);
    }
    if (this.methods.has(method) || this.notifications.has(method)) {
      throw new Error(`Notification "${method}" is already registered`);
    }
    this.notifications.set(method, handler);
  }

  /** Attach to a transport connection and start dispatching its envelopes. */
  handleConnection(connection: RpcTransportConnection): () => void {
    const state: ConnectionState = {
      initialized: false,
      controller: new AbortController(),
      pending: new Set(),
      tickets: new Set(),
    };
    this.connections.set(connection.id, state);

    let closed = false;
    const cleanupOnMessage = connection.onMessage((envelope) => {
      void this.dispatch(connection, state, envelope).catch((err) => {
        this.log.error?.("[rpc-broker] unhandled dispatch error", err);
      });
    });
    const cleanupOnClose = connection.onClose(() => {
      if (closed) return;
      closed = true;
      this.detach(connection.id);
    });

    return () => {
      if (closed) return;
      closed = true;
      cleanupOnMessage();
      cleanupOnClose();
      this.detach(connection.id);
    };
  }

  private detach(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (!state) return;
    state.controller.abort(new DOMException("RPC connection closed", "AbortError"));
    for (const ticket of [...state.tickets]) ticket.release();
    state.tickets.clear();
    this.connections.delete(connectionId);
  }

  private async dispatch(
    connection: RpcTransportConnection,
    state: ConnectionState,
    raw: unknown,
  ): Promise<void> {
    // 1. Validate envelope shape.
    const envelopeResult = validateClientEnvelope(raw);
    if (!envelopeResult.ok) {
      const rawId = typeof raw === "object" && raw !== null && "id" in raw
        ? ((raw as { id?: unknown }).id as unknown)
        : undefined;
      if (typeof rawId === "string" && rawId.length > 0) {
        await this.safeSend(connection, errorResponse(rawId, {
          code: RPC_ERROR_CODES.INVALID_REQUEST,
          message: envelopeResult.error ?? "Invalid request envelope",
          retryable: false,
        }));
      } else {
        this.log.warn?.("[rpc-broker] dropping malformed envelope without id", envelopeResult.error);
      }
      return;
    }

    const envelope = envelopeResult.value;

    // 2. Notifications never get a response and bypass admission.
    if (!isRpcRequest(envelope)) {
      await this.handleNotification(connection, state, envelope);
      return;
    }

    // 3. Request path.
    await this.handleRequest(connection, state, envelope);
  }

  private async handleNotification(
    connection: RpcTransportConnection,
    state: ConnectionState,
    envelope: RpcNotification,
  ): Promise<void> {
    // initialize is meaningless as a notification (no id); reject silently per JSON-RPC spirit.
    if (envelope.method === INITIALIZE_METHOD) {
      this.log.warn?.("[rpc-broker] initialize sent as notification, ignoring", connection.id);
      return;
    }
    if (!state.initialized) {
      // Notifications before handshake are protocol noise; drop.
      return;
    }
    const handler = this.notifications.get(envelope.method);
    if (!handler) return; // unknown notifications are ignored
    const ctx: RequestContext = {
      connectionId: connection.id,
      method: envelope.method,
      params: envelope.params,
      signal: state.controller.signal,
      initialized: state.initialized,
    };
    try {
      await handler(envelope.params, ctx);
    } catch (err) {
      this.log.warn?.("[rpc-broker] notification handler error", envelope.method, err);
    }
  }

  private async handleRequest(
    connection: RpcTransportConnection,
    state: ConnectionState,
    request: RpcRequest,
  ): Promise<void> {
    // Request id conflict within this connection.
    if (state.pending.has(request.id)) {
      await this.safeSend(connection, errorResponse(request.id, {
        code: RPC_ERROR_CODES.REQUEST_ID_CONFLICT,
        message: `A request with id "${request.id}" is already in flight on this connection`,
        retryable: false,
      }));
      return;
    }

    // initialize is the handshake and bypasses admission + the initialized gate.
    if (request.method === INITIALIZE_METHOD) {
      const response = this.handleInitialize(state, request);
      await this.safeSend(connection, response);
      return;
    }

    // Everything else requires a completed handshake.
    if (!state.initialized) {
      await this.safeSend(connection, errorResponse(request.id, {
        code: RPC_ERROR_CODES.NOT_INITIALIZED,
        message: "Connection must complete `initialize` before sending other requests",
        retryable: false,
      }));
      return;
    }

    const registration = this.methods.get(request.method);
    if (!registration) {
      await this.safeSend(connection, errorResponse(request.id, {
        code: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        message: `Unknown method: ${request.method}`,
        retryable: false,
      }));
      return;
    }

    // Bounded admission.
    let ticket: AdmissionTicket;
    try {
      ticket = this.acquire(request, registration);
    } catch (err) {
      if (err instanceof RpcMethodError) {
        await this.safeSend(connection, errorResponse(request.id, err.toRpcError()));
        return;
      }
      throw err;
    }

    state.pending.add(request.id);
    state.tickets.add(ticket);
    try {
      const ctx: RequestContext = {
        connectionId: connection.id,
        method: request.method,
        params: request.params,
        signal: state.controller.signal,
        initialized: state.initialized,
      };
      const result = await registration.handler(request.params, ctx);
      const resp: RpcSuccessResponse = successResponse(request.id, result ?? {});
      await this.safeSend(connection, resp);
    } catch (err) {
      const rpcError = err instanceof RpcMethodError
        ? err.toRpcError()
        : {
            code: RPC_ERROR_CODES.INTERNAL_ERROR,
            message: err instanceof Error ? err.message : "Internal error",
            retryable: false,
          };
      await this.safeSend(connection, errorResponse(request.id, rpcError));
    } finally {
      state.pending.delete(request.id);
      state.tickets.delete(ticket);
      ticket.release();
    }
  }

  private handleInitialize(state: ConnectionState, request: RpcRequest): RpcResponse {
    const paramsResult = validateInitializeParams(request.params);
    if (!paramsResult.ok) {
      return errorResponse(request.id, {
        code: RPC_ERROR_CODES.INVALID_PARAMS,
        message: paramsResult.error ?? "Invalid initialize params",
        retryable: false,
      });
    }
    const params = paramsResult.value;

    if (!params.protocolVersions.includes(PROTOCOL_VERSION)) {
      return errorResponse(request.id, {
        code: RPC_ERROR_CODES.UNSUPPORTED_PROTOCOL,
        message: `Server speaks protocol v${PROTOCOL_VERSION}; client offered [${params.protocolVersions.join(", ")}]`,
        retryable: false,
      });
    }

    if (state.initialized) {
      return errorResponse(request.id, {
        code: RPC_ERROR_CODES.ALREADY_INITIALIZED,
        message: "Connection is already initialized",
        retryable: false,
      });
    }

    const resume = this.resolveResume(params.resume);
    state.initialized = true;

    const result: InitializeResult = {
      protocolVersion: PROTOCOL_VERSION,
      server: this.serverInstance,
      resume,
      limits: {
        maxQueuedCommands: this.limits.maxQueuedCommands,
        maxSessionCommands: this.limits.maxSessionCommands,
        maxControlCommands: this.limits.maxControlCommands,
      },
    };
    return successResponse(request.id, result);
  }

  /**
   * Acquire an admission slot. Throws RpcMethodError(SERVER_OVERLOADED) when
   * any relevant cap is exceeded, carrying retry hints and queue metrics.
   */
  private acquire(request: RpcRequest, registration: MethodRegistration): AdmissionTicket {
    const lane = registration.lane ?? "normal";

    if (lane === "control") {
      if (this.globalControlInflight >= this.limits.maxControlCommands) {
        throw this.overloaded("control", this.globalControlInflight, this.limits.maxControlCommands);
      }
      this.globalControlInflight += 1;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          this.globalControlInflight = Math.max(0, this.globalControlInflight - 1);
        },
      };
    }

    // normal lane
    if (this.globalNormalInflight >= this.limits.maxQueuedCommands) {
      throw this.overloaded("global", this.globalNormalInflight, this.limits.maxQueuedCommands);
    }

    let sessionId: string | undefined;
    if (registration.sessionIdParam) {
      const raw = request.params[registration.sessionIdParam];
      if (typeof raw === "string" && raw.length > 0) sessionId = raw;
    }
    if (sessionId !== undefined) {
      const current = this.sessionNormalInflight.get(sessionId) ?? 0;
      if (current >= this.limits.maxSessionCommands) {
        throw this.overloaded("session", current, this.limits.maxSessionCommands, { sessionId });
      }
      this.sessionNormalInflight.set(sessionId, current + 1);
    }

    this.globalNormalInflight += 1;
    const capturedSession = sessionId;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.globalNormalInflight = Math.max(0, this.globalNormalInflight - 1);
        if (capturedSession !== undefined) {
          const next = (this.sessionNormalInflight.get(capturedSession) ?? 1) - 1;
          if (next <= 0) this.sessionNormalInflight.delete(capturedSession);
          else this.sessionNormalInflight.set(capturedSession, next);
        }
      },
    };
  }

  private overloaded(scope: string, queueDepth: number, capacity: number, extra?: Record<string, unknown>): RpcMethodError {
    return new RpcMethodError(RPC_ERROR_CODES.SERVER_OVERLOADED, `Agent ${scope} command queue is full`, {
      retryable: true,
      retryAfterMs: scope === "session" ? 200 : 800,
      details: { scope, queueDepth, capacity, ...extra },
    });
  }

  private async safeSend(connection: RpcTransportConnection, response: RpcResponse): Promise<void> {
    try {
      await connection.send(response);
    } catch (err) {
      this.log.error?.("[rpc-broker] failed to send response", connection.id, err);
    }
  }
}
