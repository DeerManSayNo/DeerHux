import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { collectTurnSkillEvidence } from "../lib/turn-skill-evidence";
import { TurnSkillEvidence } from "../components/TurnSkillEvidence";
import { buildSessionContext } from "../lib/session-reader";
import type { AgentMessage, SessionEntry, UserMessage } from "../lib/types";
const user: UserMessage = { role: "user", content: "任务", skill: { name: "design", names: ["design", "unavailable"] }, skillContext: { cwd: "/work", injected: [{ name: "design", filePath: "/work/skills/design/SKILL.md" }] } };
function operation(id: string, toolName: string, input: Record<string, unknown>, failed = false): AgentMessage[] {
  return [{ role: "assistant", model: "test", provider: "test", content: [{ type: "toolCall", toolCallId: id, toolName, input }] }, { role: "toolResult", toolCallId: id, content: [], isError: failed }];
}
const messages = [
  ...operation("read", "read", { path: "skills/design/examples/basic.md" }),
  ...operation("cat", "bash", { command: "cat '/other/new-skill/SKILL.md'" }),
  ...operation("script", "bash", { command: "python3 '/other/new-skill/scripts/run.py'" }),
  ...operation("failed", "read", { path: "/bad/fail/SKILL.md" }, true),
  ...operation("mention", "bash", { command: "echo /bad/mention/SKILL.md" }),
  ...operation("comment", "bash", { command: "cat README # /bad/comment/SKILL.md" }),
  { role: "assistant", model: "test", provider: "test", content: [{ type: "text", text: "我使用了 imaginary skill" }] } as AgentMessage,
  { role: "user", content: "下一轮" } as AgentMessage,
  ...operation("later", "read", { path: "/other/later/SKILL.md" }),
];
const evidence = collectTurnSkillEvidence(user, messages);
assert.deepEqual(evidence.selected.map(i => i.name), ["design", "unavailable"]);
assert.deepEqual(evidence.injected?.map(i => i.name), ["design"]);
assert.deepEqual(evidence.read.map(i => i.name), ["design", "new-skill"]);
assert.deepEqual(evidence.invoked.map(i => i.name), ["new-skill"]);
assert.equal(collectTurnSkillEvidence({ role: "user", content: "old", skill: { name: "selected" } }, []).injected, undefined);
assert.match(renderToStaticMarkup(<TurnSkillEvidence evidence={evidence} />), /入口调用/);
assert.doesNotMatch(renderToStaticMarkup(<TurnSkillEvidence evidence={evidence} />), /imaginary/);
const stamp = new Date().toISOString();
const entries = [
  { type: "custom", id: "context", parentId: null, timestamp: stamp, customType: "turn_context", data: { skill: user.skill, skillContext: user.skillContext } },
  { type: "custom", id: "display", parentId: "context", timestamp: stamp, customType: "display_user_message", data: { content: "任务", skill: user.skill } },
  { type: "message", id: "user", parentId: "display", timestamp: stamp, message: { role: "user", content: "模型实际输入" } },
  { type: "message", id: "next", parentId: "user", timestamp: stamp, message: { role: "user", content: "旧回合" } },
] as SessionEntry[];
const restored = buildSessionContext(entries).messages;
assert.deepEqual((restored[0] as UserMessage).skillContext, user.skillContext);
assert.equal((restored[1] as UserMessage).skillContext, undefined);
console.log("turn skill evidence and persistence tests passed");
