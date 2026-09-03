import assert from "node:assert/strict";
import {
  MINIMUM_NODE_VERSION,
  RuntimeReadinessError,
  getReadinessErrorPayload,
  isNodeVersionSupported,
} from "../lib/runtime-readiness.ts";

assert.equal(MINIMUM_NODE_VERSION, "22.19.0");
assert.equal(isNodeVersionSupported("22.18.0"), false);
assert.equal(isNodeVersionSupported("v22.19.0"), true);
assert.equal(isNodeVersionSupported("22.23.2"), true);
assert.equal(isNodeVersionSupported("23.0.0"), true);
assert.equal(isNodeVersionSupported("invalid"), false);

const known = getReadinessErrorPayload(new RuntimeReadinessError(
  "MODEL_RUNTIME_UNAVAILABLE",
  "模型运行时无法加载",
));
assert.equal(known.code, "MODEL_RUNTIME_UNAVAILABLE");
assert.equal(known.message, "模型运行时无法加载");
assert.equal(known.ready, false);

const unexpected = getReadinessErrorPayload(new Error("secret provider token"));
assert.equal(unexpected.code, "RUNTIME_READINESS_FAILED");
assert.equal(unexpected.message, "后台运行时自检失败");
assert.equal(JSON.stringify(unexpected).includes("secret provider token"), false);

console.log("runtime readiness tests passed");
