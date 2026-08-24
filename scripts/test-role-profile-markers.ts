import assert from "node:assert/strict";
import { applyRolePromptToSystemPrompt } from "../lib/roles.ts";
import { composeSystemPrompt, decomposeSystemPrompt } from "../lib/system-prompt-decomposer.ts";

const legacyPrompt = [
  "BASE",
  "",
  "<!-- PI_ROLE_PROFILE_START -->",
  "legacy role content",
  "<!-- PI_ROLE_PROFILE_END -->",
].join("\n");

const migrated = applyRolePromptToSystemPrompt(legacyPrompt);
assert.match(migrated, /<!-- DEERHUX_ROLE_PROFILE_START -->/);
assert.match(migrated, /<!-- DEERHUX_ROLE_PROFILE_END -->/);
assert.doesNotMatch(migrated, /PI_ROLE_PROFILE/);
assert.equal((migrated.match(/DEERHUX_ROLE_PROFILE_START/g) ?? []).length, 1);

for (const prompt of [legacyPrompt, migrated]) {
  const sections = decomposeSystemPrompt(prompt);
  const role = sections.find((section) => section.id === "role_profile");
  assert.equal(role?.enabled, true);
  assert.match(role?.content ?? "", /DEERHUX_ROLE_PROFILE_START/);
  assert.doesNotMatch(role?.content ?? "", /PI_ROLE_PROFILE/);
  const recomposed = composeSystemPrompt(sections);
  assert.match(recomposed, /DEERHUX_ROLE_PROFILE_START/);
  assert.doesNotMatch(recomposed, /PI_ROLE_PROFILE/);
}

console.log("role profile marker migration tests passed");
