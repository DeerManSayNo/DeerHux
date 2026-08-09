export const PROTOCOL_VERSION = 1 as const;

export const RPC_ERROR_CODES = {
  INVALID_REQUEST: "INVALID_REQUEST",
  UNSUPPORTED_PROTOCOL: "UNSUPPORTED_PROTOCOL",
  NOT_INITIALIZED: "NOT_INITIALIZED",
  ALREADY_INITIALIZED: "ALREADY_INITIALIZED",
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  INVALID_PARAMS: "INVALID_PARAMS",
  REQUEST_ID_CONFLICT: "REQUEST_ID_CONFLICT",
  SERVER_OVERLOADED: "SERVER_OVERLOADED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];
export type RpcId = string;
export type RpcParams = Record<string, unknown>;

export interface RpcRequest {
  v: typeof PROTOCOL_VERSION;
  id: RpcId;
  method: string;
  params: RpcParams;
}

export interface RpcNotification {
  v: typeof PROTOCOL_VERSION;
  method: string;
  params: RpcParams;
}

export interface RpcError {
  code: RpcErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

export interface RpcSuccessResponse {
  v: typeof PROTOCOL_VERSION;
  id: RpcId;
  result: unknown;
}

export interface RpcErrorResponse {
  v: typeof PROTOCOL_VERSION;
  id: RpcId;
  error: RpcError;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;
export type ClientEnvelope = RpcRequest | RpcNotification;
export type ServerEnvelope = RpcResponse | RpcNotification;

export interface InitializeParams {
  client: {
    name: string;
    version: string;
    instanceId: string;
  };
  protocolVersions: number[];
  resume?: {
    epoch: string;
    afterGlobalSeq: number;
  };
}

export interface InitializeResult {
  protocolVersion: typeof PROTOCOL_VERSION;
  server: {
    instanceId: string;
    version: string;
  };
  resume: {
    accepted: boolean;
    replayedThrough?: number;
  };
  limits: {
    maxQueuedCommands: number;
    maxSessionCommands: number;
    maxControlCommands: number;
  };
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function validateClientEnvelope(value: unknown): ValidationResult<ClientEnvelope> {
  if (!isRecord(value)) return { ok: false, error: "Envelope must be an object" };
  if (value.v !== PROTOCOL_VERSION) {
    return { ok: false, error: `Unsupported protocol version: ${String(value.v)}` };
  }
  if (typeof value.method !== "string" || value.method.length === 0) {
    return { ok: false, error: "method must be a non-empty string" };
  }
  if (!isRecord(value.params)) return { ok: false, error: "params must be an object" };

  if ("id" in value) {
    if (typeof value.id !== "string" || value.id.length === 0) {
      return { ok: false, error: "id must be a non-empty string" };
    }
    if (!hasOnlyKeys(value, ["v", "id", "method", "params"])) {
      return { ok: false, error: "Request contains unknown fields" };
    }
    return { ok: true, value: value as unknown as RpcRequest };
  }

  if (!hasOnlyKeys(value, ["v", "method", "params"])) {
    return { ok: false, error: "Notification contains unknown fields" };
  }
  return { ok: true, value: value as unknown as RpcNotification };
}

export function validateInitializeParams(value: unknown): ValidationResult<InitializeParams> {
  if (!isRecord(value)) return { ok: false, error: "initialize params must be an object" };
  if (!isRecord(value.client)) return { ok: false, error: "client must be an object" };

  const { client } = value;
  for (const key of ["name", "version", "instanceId"] as const) {
    if (typeof client[key] !== "string" || client[key].length === 0) {
      return { ok: false, error: `client.${key} must be a non-empty string` };
    }
  }
  if (!Array.isArray(value.protocolVersions) || value.protocolVersions.length === 0 ||
      !value.protocolVersions.every((version) => Number.isSafeInteger(version) && version > 0)) {
    return { ok: false, error: "protocolVersions must be a non-empty array of positive integers" };
  }

  if (value.resume !== undefined) {
    if (!isRecord(value.resume) || typeof value.resume.epoch !== "string" ||
        !Number.isSafeInteger(value.resume.afterGlobalSeq) || (value.resume.afterGlobalSeq as number) < 0) {
      return { ok: false, error: "resume must contain epoch and a non-negative afterGlobalSeq" };
    }
  }

  return { ok: true, value: value as unknown as InitializeParams };
}

export function isRpcRequest(envelope: ClientEnvelope): envelope is RpcRequest {
  return "id" in envelope;
}

export function isRpcErrorResponse(response: RpcResponse): response is RpcErrorResponse {
  return "error" in response;
}

export function successResponse(id: RpcId, result: unknown): RpcSuccessResponse {
  return { v: PROTOCOL_VERSION, id, result };
}

export function errorResponse(id: RpcId, error: RpcError): RpcErrorResponse {
  return { v: PROTOCOL_VERSION, id, error };
}
