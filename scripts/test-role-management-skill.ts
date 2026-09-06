import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DefaultResourceLoader, formatSkillsForPrompt, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { roleManagementSkillPath, builtinSkillPaths } from "../lib/builtin-skills.ts";
import { applyRolePromptToSystemPrompt } from "../lib/roles.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-role-skill-"));
try {
  const skillPath = roleManagementSkillPath();
  const loader = new DefaultResourceLoader({ cwd: scratch, agentDir: path.join(scratch, "agent"), additionalSkillPaths: builtinSkillPaths() });
  await loader.reload();
  const creator = loader.getSkills().skills.filter(s => s.name === "create-skill");
  assert.equal(creator.length, 1);
  assert.ok(!creator[0].disableModelInvocation);
  assert.ok(fs.existsSync(creator[0].filePath));
  assert.ok(!formatSkillsForPrompt(creator).includes("## 保存位置"));
  const skills = loader.getSkills().skills.filter(s => s.name === "create-role");
  assert.equal(skills.length, 1);
  assert.equal(fs.realpathSync(skills[0].filePath), fs.realpathSync(skillPath));
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(skillPath, "utf8"));
  assert.equal(skills[0].disableModelInvocation, frontmatter["disable-model-invocation"] === true);
  const catalog = formatSkillsForPrompt(skills);
  assert.equal(catalog.includes(skillPath), !skills[0].disableModelInvocation);
  const passiveCatalog = formatSkillsForPrompt(skills.map((skill) => ({ ...skill, disableModelInvocation: false })));
  assert.ok(passiveCatalog.includes(skillPath));
  assert.ok(!passiveCatalog.includes("POST /api/roles"));
  assert.ok(!catalog.includes("POST /api/roles"), "workflow must be loaded on demand");
  const old = "BASE\n\n<!-- DEERHUX_ROLE_PROFILE_START -->\n# Role Profile Persistence Rules\nold persistence instructions\n<!-- DEERHUX_ROLE_PROFILE_END -->";
  const prompt = applyRolePromptToSystemPrompt(old, undefined, ["TEMPORARY_SETTING"], scratch);
  assert.ok(prompt.startsWith("BASE"));
  assert.ok(prompt.includes("TEMPORARY_SETTING"));
  assert.ok(!prompt.includes("Role Profile Persistence Rules"));
  assert.ok(!prompt.includes("old persistence instructions"));
  console.log("Role management skill discovery, progressive loading, and role prompt migration passed");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
