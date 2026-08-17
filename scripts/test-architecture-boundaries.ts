import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (file: string) => readFileSync(file, "utf8");
const rpc = read("lib/rpc-manager.ts");
const port = read("lib/engine/port.ts");
const loop = read("lib/engine/deer-loop.ts");
const factory = read("lib/engine/deer-loop-engine-factory.ts");

assert.equal(existsSync("lib/deerhux-types.ts"), false);
assert.doesNotMatch(port, /LegacyAgentSessionLikeBridge|AgentSessionLike/);
assert.doesNotMatch(rpc, /@earendil-works\/pi-(?:coding-agent|ai)/);
assert.doesNotMatch(rpc, /inner\.(?:sessionManager|settingsManager|modelRegistry|agent|navigateTree)/);
assert.doesNotMatch(loop, /AgentSessionEvent/);
assert.match(factory, /new DeerLoopEngine\(options\)/);
assert.match(rpc, /__deerhuxSessionStartReservations/);
assert.match(rpc, /throw new SessionCapacityError\(MAX_REGISTRY_SESSIONS\)/);
assert.match(rpc, /finally\(\(\) => \{[\s\S]*__deerhuxSessionStartReservations/);

for (const file of [
  "lib/rpc-manager.ts",
  "lib/engine/deer-loop-composition.ts",
  "lib/engine/port.ts",
]) {
  if (file === "lib/engine/deer-loop-composition.ts") continue;
  assert.doesNotMatch(read(file), /new DeerLoopEngine\(/, `${file} must not construct DeerLoopEngine`);
}

console.log("architecture boundary tests passed");
