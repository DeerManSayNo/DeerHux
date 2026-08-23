import assert from "node:assert/strict";
import {
  getTransportDiagnostics,
  openSseConnection,
  recordBaseline,
  recordFreshConnection,
  recordReplay,
  recordResumedConnection,
  recordSlowConsumerDrop,
  recordSnapshotRequired,
  recordSseFrame,
  resetTransportDiagnosticsForTests,
} from "../lib/agent-runtime/transport-diagnostics.ts";

resetTransportDiagnosticsForTests();
let now = 100;
const closeFirst = openSseConnection(() => now);
const closeSecond = openSseConnection(() => now);
assert.equal(getTransportDiagnostics().activeSseConnectionsPeak, 2);
now = 175;
closeFirst("abort");
closeFirst("write_error");
now = 225;
closeSecond("write_error");

recordFreshConnection();
recordResumedConnection();
recordSnapshotRequired("cursor_evicted");
recordSnapshotRequired("future_reason");
recordReplay({ events: 3, bytes: 900, durationMs: 12, lagEvents: 5 });
recordReplay({ events: 0, bytes: 0, durationMs: 2, lagEvents: 0 });
recordSseFrame(100, "agent_event", 20);
recordSseFrame(20, "control", -10);
recordSseFrame(3, "heartbeat", 5);
recordSlowConsumerDrop("replay");
recordBaseline({
  durationMs: 7,
  frames: 4,
  bytes: 500,
  sessions: 2,
  transientSnapshots: 2,
  subagentParents: 1,
  subagentRuns: 3,
});

const diagnostics = getTransportDiagnostics();
assert.equal(diagnostics.activeSseConnections, 0);
assert.equal(diagnostics.openedSseConnections, 2);
assert.equal(diagnostics.closedSseConnections, 2);
assert.equal(diagnostics.connectionAbortsTotal, 1);
assert.equal(diagnostics.connectionWriteErrorsTotal, 1);
assert.equal(diagnostics.connectionDurationMsTotal, 200);
assert.equal(diagnostics.connectionDurationMsMax, 125);
assert.equal(diagnostics.freshConnectionsTotal, 1);
assert.equal(diagnostics.resumedConnectionsTotal, 1);
assert.equal(diagnostics.snapshotRequiredTotal, 2);
assert.equal(diagnostics.snapshotRequiredByReason.cursor_evicted, 1);
assert.equal(diagnostics.snapshotRequiredByReason.unknown, 1);
assert.equal(diagnostics.replayRequestsTotal, 2);
assert.equal(diagnostics.replayEventsTotal, 3);
assert.equal(diagnostics.replayBytesTotal, 900);
assert.equal(diagnostics.replayEmptyTotal, 1);
assert.equal(diagnostics.replayEventsMax, 3);
assert.equal(diagnostics.replayBytesMax, 900);
assert.equal(diagnostics.replayDurationMsTotal, 14);
assert.equal(diagnostics.replayDurationMsMax, 12);
assert.equal(diagnostics.replayLagEventsMax, 5);
assert.equal(diagnostics.framesSentTotal, 3);
assert.equal(diagnostics.bytesSentTotal, 123);
assert.equal(diagnostics.agentEventFramesSentTotal, 1);
assert.equal(diagnostics.controlFramesSentTotal, 1);
assert.equal(diagnostics.heartbeatFramesSentTotal, 1);
assert.equal(diagnostics.minimumDesiredSizeObserved, -10);
assert.equal(diagnostics.slowConsumerDrops, 1);
assert.equal(diagnostics.slowConsumerDropsByPhase.replay, 1);
assert.equal(diagnostics.baselineBuildsTotal, 1);
assert.equal(diagnostics.baselineBuildDurationMsMax, 7);
assert.equal(diagnostics.baselineFramesSentTotal, 4);
assert.equal(diagnostics.baselineBytesSentTotal, 500);
assert.equal(diagnostics.baselineSessionsLast, 2);
assert.equal(diagnostics.baselineTransientSnapshotsLast, 2);
assert.equal(diagnostics.baselineSubagentParentsLast, 1);
assert.equal(diagnostics.baselineSubagentRunsLast, 3);

// Returned nested objects must not mutate process-global counters.
diagnostics.snapshotRequiredByReason.cursor_evicted = 99;
diagnostics.slowConsumerDropsByPhase.replay = 99;
const freshCopy = getTransportDiagnostics();
assert.equal(freshCopy.snapshotRequiredByReason.cursor_evicted, 1);
assert.equal(freshCopy.slowConsumerDropsByPhase.replay, 1);
assert.ok(freshCopy.sseHighWaterMarkBytes > 0);
assert.ok(freshCopy.sseMaxQueuedBytes > freshCopy.sseHighWaterMarkBytes);

console.log("transport diagnostics tests passed");
