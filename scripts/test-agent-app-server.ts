/**
 * Phase 0 targeted tests for the Agent App Server skeleton.
 *
 * Run (project convention):  npx tsx scripts/test-agent-app-server.ts
 * Run (Node 24+, no deps):   node --no-warnings scripts/test-agent-app-server.ts
 *
 * Covers: protocol validators, initialize handshake, request/response and
 * notification dispatch, explicit error mapping, request-id conflict,
 * bounded admission (global normal, control lane, per-session), resume hook.
 */
import assert from "node:assert/strict";

import {
  PROTOCOL_VERSION,
  RPC_ERROR_CODES,
  validateClientEnvelope,
  validateInitializeParams,
  isRpcRequest,
  isRpcErrorResponse,
  type RpcResponse,
  type ServerEnvelope,
} from "../lib/agent-app-server/protocol.ts";
import { RpcBroker, RpcMethodError } from "../lib/agent-app-server/broker.ts";
import { createInProcessTransport, type InProcessClient } from "../lib/agent-app-server/transports/in-process.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── helpers ────────────────────────────────────────────────────────────────
function capture(client: InProcessClient) {
  const messages: ServerEnvelope[] = [];
  client.onMessage((m) => messages.push(m));
  return {
    messages,
    async waitForResponse(id: string, timeoutMs = 1000): Promise<RpcResponse> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find((m): m is RpcResponse => "id" in m && (m as RpcResponse).id === id);
        if (found) return found;
        await sleep(2);
      }
      throw new Error(`timeout waiting for response id=${id}`);
    },
    hasResponseFor(id: string): boolean {
      return messages.some((m) => "id" in m && (m as RpcResponse).id === id);
    },
  };
}

function req(id: string, method: string, params: Record<string, unknown> = {}) {
  return { v: PROTOCOL_VERSION, id, method, params };
}
function notify(method: string, params: Record<string, unknown> = {}) {
  return { v: PROTOCOL_VERSION, method, params };
}

function initParams(over: Partial<{ protocolVersions: number[]; resume: { epoch: string; afterGlobalSeq: number } }> = {}) {
  return {
    client: { name: "deerhux-test", version: "0.0.0", instanceId: "test-instance" },
    protocolVersions: over.protocolVersions ?? [1],
    ...(over.resume ? { resume: over.resume } : {}),
  };
}

function errCode(resp: RpcResponse): string {
  return (resp as { error?: { code?: string } }).error?.code ?? "<none>";
}
function errDetails(resp: RpcResponse): Record<string, unknown> {
  return (resp as { error?: { details?: Record<string, unknown> } }).error?.details ?? {};
}

// ── protocol.ts validators ─────────────────────────────────────────────────
{
  const okReq = validateClientEnvelope({ v: 1, id: "r1", method: "ping", params: {} });
  assert.equal(okReq.ok, true, "valid request envelope");
  assert.equal(isRpcRequest(okReq.value!), true);

  const okNotif = validateClientEnvelope({ v: 1, method: "event", params: { a: 1 } });
  assert.equal(okNotif.ok, true, "valid notification envelope");
  assert.equal(isRpcRequest(okNotif.value!), false, "notification is not a request");

  assert.equal(validateClientEnvelope({ id: "r1", method: "m", params: {} }).ok, false, "missing v");
  assert.equal(validateClientEnvelope({ v: 2, id: "r1", method: "m", params: {} }).ok, false, "wrong v");
  assert.equal(validateClientEnvelope({ v: 1, id: "r1", params: {} }).ok, false, "missing method");
  assert.equal(validateClientEnvelope({ v: 1, id: "r1", method: "", params: {} }).ok, false, "empty method");
  assert.equal(validateClientEnvelope({ v: 1, id: "r1", method: "m" }).ok, false, "missing params");
  assert.equal(validateClientEnvelope({ v: 1, id: "r1", method: "m", params: [] }).ok, false, "params array");
  assert.equal(validateClientEnvelope({ v: 1, id: "", method: "m", params: {} }).ok, false, "empty id");
  assert.equal(validateClientEnvelope({ v: 1, id: "r1", method: "m", params: {}, extra: 1 }).ok, false, "unknown field");
  assert.equal(validateClientEnvelope(null).ok, false, "null envelope");
}

{
  assert.equal(validateInitializeParams(initParams()).ok, true, "valid initialize params");
  assert.equal(validateInitializeParams({ ...initParams(), client: { name: "", version: "x", instanceId: "y" } }).ok, false, "empty client.name");
  assert.equal(validateInitializeParams({ ...initParams(), protocolVersions: [] }).ok, false, "empty protocolVersions");
  assert.equal(validateInitializeParams({ ...initParams(), protocolVersions: [1.5] }).ok, false, "non-integer protocol version");
  assert.equal(validateInitializeParams({ ...initParams(), resume: { epoch: "e", afterGlobalSeq: -1 } }).ok, false, "negative afterGlobalSeq");
  assert.equal(validateInitializeParams(undefined).ok, false, "undefined params");
}

// ── broker: initialize handshake ───────────────────────────────────────────
{
  const broker = new RpcBroker({ serverInstance: { instanceId: "epoch_test", version: "0.6.12" } });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  client.send(req("init", "initialize", initParams()));
  const resp = await cap.waitForResponse("init");
  assert.equal(isRpcErrorResponse(resp), false, "initialize should succeed");
  const result = (resp as { result: Record<string, unknown> }).result;
  assert.equal(result.protocolVersion, 1, "negotiated protocolVersion");
  assert.equal((result.server as { instanceId: string }).instanceId, "epoch_test");
  assert.deepEqual(result.resume, { accepted: false }, "Phase 0 default resume not accepted");
  assert.equal((result.limits as { maxQueuedCommands: number }).maxQueuedCommands, 128);
}

// ── broker: resume hook injection ───────────────────────────────────────────
{
  const broker = new RpcBroker({
    serverInstance: { instanceId: "epoch_test", version: "0.6.12" },
    resolveResume: (resume) => ({ accepted: true, replayedThrough: resume ? resume.afterGlobalSeq : undefined }),
  });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  client.send(req("init2", "initialize", initParams({ resume: { epoch: "epoch_test", afterGlobalSeq: 42 } })));
  const resp = await cap.waitForResponse("init2");
  const result = (resp as { result: { resume: { accepted: boolean; replayedThrough?: number } } }).result;
  assert.equal(result.resume.accepted, true, "resume resolver honored");
  assert.equal(result.resume.replayedThrough, 42, "replayedThrough returned");
}

// ── broker: NOT_INITIALIZED before handshake ───────────────────────────────
{
  const broker = new RpcBroker({ serverInstance: { instanceId: "e", version: "v" } });
  broker.registerMethod("ping", { lane: "control", handler: () => "pong" });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  client.send(req("p1", "ping"));
  const resp = await cap.waitForResponse("p1");
  assert.equal(errCode(resp), RPC_ERROR_CODES.NOT_INITIALIZED);
}

// ── broker: ALREADY_INITIALIZED ─────────────────────────────────────────────
{
  const broker = new RpcBroker({ serverInstance: { instanceId: "e", version: "v" } });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  client.send(req("i1", "initialize", initParams()));
  await cap.waitForResponse("i1");
  client.send(req("i2", "initialize", initParams()));
  const resp = await cap.waitForResponse("i2");
  assert.equal(errCode(resp), RPC_ERROR_CODES.ALREADY_INITIALIZED);
}

// ── broker: UNSUPPORTED_PROTOCOL does not initialize the connection ─────────
{
  const broker = new RpcBroker({ serverInstance: { instanceId: "e", version: "v" } });
  broker.registerMethod("ping", { lane: "control", handler: () => "pong" });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  client.send(req("i3", "initialize", initParams({ protocolVersions: [99, 100] })));
  const bad = await cap.waitForResponse("i3");
  assert.equal(errCode(bad), RPC_ERROR_CODES.UNSUPPORTED_PROTOCOL);

  // connection must NOT be marked initialized after a failed initialize
  client.send(req("after", "ping"));
  const after = await cap.waitForResponse("after");
  assert.equal(errCode(after), RPC_ERROR_CODES.NOT_INITIALIZED, "failed initialize must not ready the connection");
}

// ── broker: METHOD_NOT_FOUND ────────────────────────────────────────────────
{
  const broker = new RpcBroker({ serverInstance: { instanceId: "e", version: "v" } });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  client.send(req("init", "initialize", initParams()));
  await cap.waitForResponse("init");
  client.send(req("m1", "nope/not-real"));
  const resp = await cap.waitForResponse("m1");
  assert.equal(errCode(resp), RPC_ERROR_CODES.METHOD_NOT_FOUND);
}

// ── broker: request/response + INVALID_PARAMS ───────────────────────────────
{
  const broker = new RpcBroker({ serverInstance: { instanceId: "e", version: "v" } });
  broker.registerMethod("turn/start", {
    sessionIdParam: "threadId",
    handler: (params) => {
      if (typeof params.text !== "string") {
        throw new RpcMethodError(RPC_ERROR_CODES.INVALID_PARAMS, "text is required");
      }
      return { accepted: true, threadId: params.threadId, turnId: "t1" };
    },
  });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  client.send(req("init", "initialize", initParams()));
  await cap.waitForResponse("init");

  client.send(req("t1", "turn/start", { threadId: "s1", text: "hello" }));
  const ok = await cap.waitForResponse("t1");
  assert.deepEqual((ok as { result: unknown }).result, { accepted: true, threadId: "s1", turnId: "t1" });

  client.send(req("t2", "turn/start", { threadId: "s1" }));
  const bad = await cap.waitForResponse("t2");
  assert.equal(errCode(bad), RPC_ERROR_CODES.INVALID_PARAMS);
  assert.match((bad as { error: { message: string } }).error.message, /text is required/);
}

// ── broker: unhandled error → INTERNAL_ERROR ────────────────────────────────
{
  const broker = new RpcBroker({ serverInstance: { instanceId: "e", version: "v" } });
  broker.registerMethod("boom", { handler: () => { throw new Error("kaboom"); } });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  client.send(req("init", "initialize", initParams()));
  await cap.waitForResponse("init");
  client.send(req("b1", "boom"));
  const resp = await cap.waitForResponse("b1");
  assert.equal(errCode(resp), RPC_ERROR_CODES.INTERNAL_ERROR);
  assert.equal((resp as { error: { message: string } }).error.message, "kaboom");
}

// ── broker: request id conflict ─────────────────────────────────────────────
{
  const broker = new RpcBroker({ serverInstance: { instanceId: "e", version: "v" } });
  let resolveLater: () => void = () => {};
  broker.registerMethod("slow", { handler: () => new Promise<void>((r) => { resolveLater = r; }) });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  client.send(req("init", "initialize", initParams()));
  await cap.waitForResponse("init");

  client.send(req("dup", "slow")); // now in-flight
  await sleep(10);
  client.send(req("dup", "slow")); // same id while in-flight
  const conflict = await cap.waitForResponse("dup");
  assert.equal(errCode(conflict), RPC_ERROR_CODES.REQUEST_ID_CONFLICT);
  resolveLater(); // release the in-flight one so the process can settle
  await sleep(5);
}

// ── broker: notification (no response, no admission) ───────────────────────
{
  const broker = new RpcBroker({ serverInstance: { instanceId: "e", version: "v" } });
  const seen: string[] = [];
  broker.registerNotification("events/ack", (params) => { seen.push(String((params as { cursor?: unknown }).cursor)); });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  client.send(req("init", "initialize", initParams()));
  await cap.waitForResponse("init");
  const before = cap.messages.length;
  client.send(notify("events/ack", { cursor: "1042" }));
  await sleep(20);
  assert.deepEqual(seen, ["1042"], "notification handler invoked");
  assert.equal(cap.messages.length, before, "notification produced no response");
}

// ── broker: bounded admission — global normal queue ─────────────────────────
{
  const broker = new RpcBroker({
    serverInstance: { instanceId: "e", version: "v" },
    limits: { maxQueuedCommands: 2, maxSessionCommands: 99, maxControlCommands: 99 },
  });
  const gates: (() => void)[] = [];
  broker.registerMethod("work", { handler: () => new Promise<void>((r) => { gates.push(r); }) });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  client.send(req("init", "initialize", initParams()));
  await cap.waitForResponse("init");

  client.send(req("w1", "work"));
  client.send(req("w2", "work"));
  await sleep(10); // both enter in-flight
  assert.equal(cap.hasResponseFor("w1"), false, "w1 in-flight");
  assert.equal(cap.hasResponseFor("w2"), false, "w2 in-flight");

  client.send(req("w3", "work")); // exceeds global cap of 2
  const overloaded = await cap.waitForResponse("w3");
  assert.equal(errCode(overloaded), RPC_ERROR_CODES.SERVER_OVERLOADED);
  assert.equal((overloaded as { error: { retryable: boolean } }).error.retryable, true);
  const details = errDetails(overloaded);
  assert.equal(details.scope, "global");
  assert.equal(details.queueDepth, 2);
  assert.equal(details.capacity, 2);

  // drain w1, w2 → capacity frees
  gates.splice(0).forEach((fn) => fn());
  await cap.waitForResponse("w1");
  await cap.waitForResponse("w2");

  // w4 now admitted (in-flight), proving capacity recovered
  client.send(req("w4", "work"));
  await sleep(10);
  assert.equal(cap.hasResponseFor("w4"), false, "w4 admitted and in-flight after drain");
  gates.splice(0).forEach((fn) => fn()); // release w4
  const ok = await cap.waitForResponse("w4");
  assert.equal("result" in ok, true, "w4 completes once its gate resolves");
}

// ── broker: bounded admission — per-session cap ─────────────────────────────
{
  const broker = new RpcBroker({
    serverInstance: { instanceId: "e", version: "v" },
    limits: { maxQueuedCommands: 99, maxSessionCommands: 1, maxControlCommands: 99 },
  });
  const gates: (() => void)[] = [];
  broker.registerMethod("turn/start", { sessionIdParam: "threadId", handler: () => new Promise<void>((r) => { gates.push(r); }) });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  client.send(req("init", "initialize", initParams()));
  await cap.waitForResponse("init");

  client.send(req("a1", "turn/start", { threadId: "sessA" }));
  await sleep(10);
  assert.equal(cap.hasResponseFor("a1"), false, "a1 in-flight");

  client.send(req("a2", "turn/start", { threadId: "sessA" })); // 2nd on same session
  const overloaded = await cap.waitForResponse("a2");
  assert.equal(errCode(overloaded), RPC_ERROR_CODES.SERVER_OVERLOADED);
  const details = errDetails(overloaded);
  assert.equal(details.scope, "session");
  assert.equal(details.sessionId, "sessA");

  // a different session is admitted independently (in-flight, no rejection)
  client.send(req("b1", "turn/start", { threadId: "sessB" }));
  await sleep(10);
  assert.equal(cap.hasResponseFor("b1"), false, "different session admitted");

  gates.splice(0).forEach((fn) => fn()); // drain a1, b1
  await sleep(10);
}

// ── broker: control lane independent of normal lane ─────────────────────────
{
  const broker = new RpcBroker({
    serverInstance: { instanceId: "e", version: "v" },
    limits: { maxQueuedCommands: 1, maxSessionCommands: 99, maxControlCommands: 1 },
  });
  const normalGates: (() => void)[] = [];
  broker.registerMethod("turn/start", { sessionIdParam: "threadId", handler: () => new Promise<void>((r) => { normalGates.push(r); }) });
  broker.registerMethod("turn/interrupt", { lane: "control", handler: () => ({ interrupted: true }) });
  const ctrlGates: (() => void)[] = [];
  broker.registerMethod("ping", { lane: "control", handler: () => new Promise<void>((r) => { ctrlGates.push(r); }) });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  client.send(req("init", "initialize", initParams()));
  await cap.waitForResponse("init");

  // saturate normal lane
  client.send(req("t1", "turn/start", { threadId: "s1" }));
  await sleep(10);
  assert.equal(cap.hasResponseFor("t1"), false, "normal lane saturated");

  // control lane still serves immediately while normal is full
  client.send(req("c1", "turn/interrupt", { threadId: "s1" }));
  const ctrl = await cap.waitForResponse("c1");
  assert.deepEqual((ctrl as { result: unknown }).result, { interrupted: true }, "control admitted while normal full");

  // 2nd control exceeds cap: first control in-flight, second rejected
  client.send(req("p1", "ping"));
  await sleep(10);
  client.send(req("p2", "ping"));
  const overloaded = await cap.waitForResponse("p2");
  assert.equal(errCode(overloaded), RPC_ERROR_CODES.SERVER_OVERLOADED);
  assert.equal(errDetails(overloaded).scope, "control");

  normalGates.splice(0).forEach((fn) => fn());
  ctrlGates.splice(0).forEach((fn) => fn());
  await sleep(10);
}

// ── broker: malformed envelope with id → INVALID_REQUEST ───────────────────
{
  const broker = new RpcBroker({ serverInstance: { instanceId: "e", version: "v" } });
  const { server, client } = createInProcessTransport();
  broker.handleConnection(server);
  const cap = capture(client);

  // send a raw (untyped) envelope to simulate a bad client
  (client as unknown as { send: (m: unknown) => void }).send({ v: 1, id: "bad", method: "m", params: {}, rogue: true });
  const resp = await cap.waitForResponse("bad");
  assert.equal(errCode(resp), RPC_ERROR_CODES.INVALID_REQUEST);
}

console.log("agent-app-server Phase 0 tests passed");
