import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasCli, readSkillCliDependencies } from "../lib/skill-cli.ts";

const root = await mkdtemp(path.join(tmpdir(), "deerhux-cli-test-"));
try {
  const command = "deerhux-cli-test-executable";
  const binary = path.join(root, command);
  await writeFile(binary, "test");
  await chmod(binary, 0o755);
  assert.equal(await hasCli(command, { PATH: root }, "darwin"), true);
  await chmod(binary, 0o644);
  assert.equal(await hasCli(command, { PATH: root }, "darwin"), false);
  await mkdir(path.join(root, "directory-command"));
  assert.equal(await hasCli("directory-command", { PATH: root }, "darwin"), false);
  assert.equal(await hasCli("evil;touch", { PATH: root }), false);
  assert.equal(await hasCli("../escape", { PATH: root }), false);
  const file = path.join(root, "SKILL.md");
  await writeFile(file, `---\nname: test\ncli-dependencies:\n  - command: absent-test-cli-9977\n    install-url: https://example.com/download\n  - command: unsupported-test-cli\n    platforms: [not-a-platform]\n    install-url: javascript:alert(1)\n  - command: 'evil;touch'\n---\n`);
  const dependencies = await readSkillCliDependencies(file);
  assert.equal(dependencies.length, 2);
  assert.equal(dependencies[0].status, "missing");
  assert.equal(dependencies[0].installUrl, "https://example.com/download");
  assert.equal(dependencies[1].status, "unsupported");
  assert.equal(dependencies[1].installUrl, undefined);
  await writeFile(file, "---\nname: no-cli\n---\n");
  assert.deepEqual(await readSkillCliDependencies(file), []);
  console.log("Skill CLI dependency checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
