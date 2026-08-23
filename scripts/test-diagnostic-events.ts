import assert from "node:assert/strict";
import {
  getRuntimeDiagnosticEvents,
  recordRuntimeDiagnosticEvent,
  resetRuntimeDiagnosticEventsForTests,
} from "../lib/agent-runtime/diagnostic-events.ts";

resetRuntimeDiagnosticEventsForTests();
for (let index = 0; index < 205; index += 1) {
  recordRuntimeDiagnosticEvent({
    timestamp: index,
    level: index % 2 === 0 ? "info" : "warn",
    component: "sse-server",
    event: "replay_completed",
    connectionId: `connection-${index}`,
    globalSeq: index,
    eventCount: 1,
    byteCount: 10,
  });
}
const retained = getRuntimeDiagnosticEvents(500);
assert.equal(retained.length, 200);
assert.equal(retained[0].globalSeq, 5);
assert.equal(retained.at(-1)?.globalSeq, 204);
assert.equal(getRuntimeDiagnosticEvents(2).length, 2);

const copy = getRuntimeDiagnosticEvents(1);
copy[0].connectionId = "mutated";
assert.equal(getRuntimeDiagnosticEvents(1)[0].connectionId, "connection-204");

console.log("diagnostic event tests passed");
