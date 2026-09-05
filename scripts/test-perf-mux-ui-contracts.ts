import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const muxRoute = source("app/api/agent/events/route.ts");
const client = source("lib/agent-event-client.ts");
const appShell = source("components/AppShell.tsx");
const chatWindow = source("components/ChatWindow.tsx");
const subagentCard = source("components/SubagentRunCard.tsx");
const collaborationUiState = source("lib/collaboration-ui-state.ts");
const collaborationMux = source("lib/parallel-agent/collaboration-mux.ts");
const sessionHook = source("hooks/useAgentSession.ts");
const rpcManager = source("lib/rpc-manager.ts");
const collaborationStore = source("lib/parallel-agent/collaboration-store.ts");
const hostBus = source("lib/host-event-bus.ts");

assert.match(muxRoute, /host_running_snapshot/);
assert.match(muxRoute, /listRpcSessionTransientSnapshots/);
assert.match(muxRoute, /subagent_runs_snapshot/);
assert.match(muxRoute, /toCollaborationMuxSnapshot/);
assert.doesNotMatch(muxRoute, /sanitizeCollaborationRun/);
assert.match(muxRoute, /hostEventBus\.subscribe/);
assert.match(muxRoute, /recordFreshConnection/);
assert.match(muxRoute, /recordResumedConnection/);
assert.match(muxRoute, /recordSnapshotRequired\(replay\.reason\)/);
assert.match(muxRoute, /recordReplay/);
assert.match(muxRoute, /recordSlowConsumerDrop\(sendPhase\)/);
assert.match(muxRoute, /recordSlowConsumerDrop\("heartbeat"\)/);
assert.match(muxRoute, /recordSseFrame/);
assert.match(muxRoute, /parsedCursor\.kind === "invalid"[\s\S]*?reason: "invalid_cursor"/);
assert.match(muxRoute, /store\.subscribeAll[\s\S]*?store\.getGlobalSince/);
assert.match(muxRoute, /connectionId/);
assert.match(muxRoute, /"X-Accel-Buffering": "no"/);

assert.match(client, /subscribeHostEvents/);
assert.match(client, /subscribeSessionTransient/);
assert.match(client, /subscribeSubagentRuns/);
assert.match(client, /clearMirrors\(\)/);
assert.match(client, /if \(this\.cursor && this\.cursor\.epoch !== data\.epoch\) this\.clearMirrors\(\)/);
assert.match(client, /if \(data\.type === "snapshot_required"\)[\s\S]*?this\.clearMirrors\(\)/);
assert.match(client, /frame\.authoritative === true[\s\S]*?this\.transientMirror\.delete/);
assert.match(client, /frame\.authoritative === true[\s\S]*?this\.subagentMirror\.clear/);
assert.match(client, /backgroundEvents\.clear\(\)/);
assert.match(client, /recoverBackgroundOverflow/);
assert.match(client, /getAgentEventClientDiagnostics/);
assert.match(client, /duplicateEventsDroppedTotal/);
assert.match(client, /epochMismatchEventsDroppedTotal/);
assert.match(client, /snapshotRecoverySucceededTotal/);
assert.match(client, /recoveryBufferOverflowsTotal/);
assert.match(client, /isCollaborationSnapshotOlder\(frame\.run, old\)/);
assert.match(client, /backgroundEvents\.diagnostics\(\)/);

assert.doesNotMatch(appShell, /setInterval\(loadRunningSessions,\s*2000\)/);
assert.doesNotMatch(appShell, /setInterval\([\s\S]{0,100}setRefreshKey[\s\S]{0,100}10000\)/);
assert.match(appShell, /subscribeHostEvents/);

assert.doesNotMatch(chatWindow, /setInterval\(fetchRuns/);
assert.match(chatWindow, /subscribeSubagentRuns/);
assert.match(chatWindow, /fetch\(`\/api\/agent-runs\?parentSessionId=/);
assert.match(chatWindow, /hydratingRunIdsRef/);
assert.match(chatWindow, /pendingRunMuxSnapshotsRef/);
assert.match(chatWindow, /\/api\/agent-runs\/\$\{encodeURIComponent\(runId\)\}/);
assert.doesNotMatch(subagentCard, /new EventSource/);
assert.doesNotMatch(subagentCard, /setInterval/);
assert.match(subagentCard, /SubagentRunActions run=\{latest\} onRunUpdate=\{onRunUpdate\}/);
assert.match(subagentCard, /\/workers\/\$\{encodeURIComponent\(worker\.workerId\)\}\/session/);
assert.match(subagentCard, /onOpenSession\(payload\.sessionId\)/);
assert.match(subagentCard, /event\.key !== "Enter" && event\.key !== " "/);
assert.doesNotMatch(chatWindow, /return !oldWorker\?\.sessionId/);
assert.match(chatWindow, /collaborationNeedsHydration/);
assert.match(collaborationUiState, /version: version\(snapshot\)/);
assert.match(collaborationUiState, /recoveryState: snapshot\.recoveryState/);
assert.match(collaborationUiState, /staleArtifact \? \{ patchSha256: undefined/);
assert.match(collaborationMux, /patchSha256: worker\.patchSha256/);

assert.match(sessionHook, /subscribeSessionTransient/);
assert.match(sessionHook, /HTTP[\s\S]{0,100}must never overwrite it/);
assert.doesNotMatch(sessionHook, /stillRunning = Boolean\(state\?\.running/);

assert.match(rpcManager, /running: status\.isRunning/);
assert.match(rpcManager, /filter\(\(state\) => state\.isRunning \|\| state\.isCompacting\)/);
assert.doesNotMatch(rpcManager, /running: status\.isStreaming/);

assert.match(collaborationStore, /run: toCollaborationMuxSnapshot\(state\)/);
assert.match(collaborationStore, /run: removedCollaborationMuxSnapshot\(runId\)/);
assert.doesNotMatch(collaborationStore, /run: sanitizeCollaborationRun\(state\)/);
assert.match(hostBus, /runs: CollaborationMuxSnapshot\[\]/);
assert.doesNotMatch(hostBus, /CollaborationRunSnapshot/);

console.log("perf mux UI contracts: ok");
