import assert from "node:assert/strict";
import { businessRecoveryDelayMs, eligibleRecoveryEvents } from "../lib/agent-runtime/recovery-buffer.ts";

const events = [
  ...Array.from({ length: 100 }, (_, index) => ({ epoch: "current", globalSeq: 101 - index })),
  { epoch: "old", globalSeq: 999 },
];
const eligible = eligibleRecoveryEvents(events, "current", 1);
assert.equal(eligible.length, 100);
assert.deepEqual(eligible.map((event) => event.globalSeq), Array.from({ length: 100 }, (_, index) => index + 2));
assert.deepEqual(eligibleRecoveryEvents(events, "current", 100).map((event) => event.globalSeq), [101]);

const delivered: number[] = [];
let remaining: typeof eligible = [];
for (let index = 0; index < eligible.length; index += 1) {
  delivered.push(eligible[index].globalSeq);
  if (index === 9) {
    remaining = eligible.slice(index + 1);
    break;
  }
}
assert.equal(delivered.length, 10);
assert.equal(remaining.length, 90);
assert.equal(remaining[0].globalSeq, 12);
assert.equal(remaining.at(-1)?.globalSeq, 101);

assert.deepEqual(
  Array.from({ length: 8 }, (_, attempt) => businessRecoveryDelayMs(attempt)),
  [0, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000],
);
console.log("recovery buffer tests passed");
