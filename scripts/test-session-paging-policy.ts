import assert from "node:assert/strict";
import { getRecentMessageIndexes, isSessionPagingEnabled } from "../lib/session/paging-policy.ts";

const previous = process.env.DEERHUX_SESSION_PAGING;
try {
  delete process.env.DEERHUX_SESSION_PAGING;
  assert.equal(isSessionPagingEnabled(), true);
  process.env.DEERHUX_SESSION_PAGING = "1";
  assert.equal(isSessionPagingEnabled(), true);
  process.env.DEERHUX_SESSION_PAGING = "0";
  assert.equal(isSessionPagingEnabled(), false);
} finally {
  if (previous === undefined) delete process.env.DEERHUX_SESSION_PAGING;
  else process.env.DEERHUX_SESSION_PAGING = previous;
}

assert.deepEqual(getRecentMessageIndexes(5, 3), [2, 3, 4]);
assert.deepEqual(getRecentMessageIndexes(5, 3, true), [0, 3, 4]);
assert.deepEqual(getRecentMessageIndexes(3, 3, true), [0, 1, 2]);
assert.deepEqual(getRecentMessageIndexes(5, 1, true), [0]);
assert.deepEqual(getRecentMessageIndexes(210, 100, false, [63]), [63, ...Array.from({ length: 99 }, (_, index) => 111 + index)]);
assert.deepEqual(getRecentMessageIndexes(210, 100, true, [63]), [0, 63, ...Array.from({ length: 98 }, (_, index) => 112 + index)]);
assert.deepEqual(getRecentMessageIndexes(210, 100, true, [0]), [0, ...Array.from({ length: 99 }, (_, index) => 111 + index)]);

console.log("session paging policy tests passed");
