import assert from "node:assert/strict";
import { isSessionPagingEnabled } from "../lib/session/paging-policy.ts";

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
console.log("session paging policy tests passed");
