import assert from "node:assert/strict";
import {
  canEditMemory,
  failedState,
  loadingState,
  readRequiredArray,
  readyState,
} from "../lib/memory-config-state.ts";

assert.deepEqual(readRequiredArray<{ id: string }>({ global: [] }, "global"), []);
assert.deepEqual(readRequiredArray<{ id: string }>({ roles: [{ id: "role-1" }] }, "roles"), [{ id: "role-1" }]);
assert.throws(() => readRequiredArray({}, "global"), /缺少 global 数组/);
assert.throws(() => readRequiredArray({ global: null }, "global"), /缺少 global 数组/);

assert.deepEqual(loadingState(["previous"]), { status: "loading", data: ["previous"] });
assert.deepEqual(readyState<string[]>([]), { status: "ready", data: [] });
assert.deepEqual(failedState(["previous"], "请求失败"), { status: "error", data: ["previous"], error: "请求失败" });

assert.equal(canEditMemory("ready", "ready"), true);
assert.equal(canEditMemory("ready", "error"), false);
assert.equal(canEditMemory("error", "ready"), false);
assert.equal(canEditMemory("loading", "ready"), false);

console.log("memory config state tests passed");
