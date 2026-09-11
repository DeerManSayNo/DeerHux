import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageView } from "../components/MessageView";
import { skillNames, skillReference, skillQueryAtCaret } from "../lib/skill-selection";
import { buildSessionContext } from "../lib/session-reader";
import type { SessionEntry, UserMessage } from "../lib/types";

assert.deepEqual(skillNames({ name: "old" }), ["old"]);
assert.deepEqual(skillReference([" a ", "b", "a", "", 3]), { name: "a", names: ["a", "b"] });
assert.equal(skillReference([]), undefined);
assert.deepEqual(skillQueryAtCaret("正文 /des 后文", 7), { start: 3, end: 7, query: "des" });
assert.deepEqual(skillQueryAtCaret("/", 1), { start: 0, end: 1, query: "" });
assert.equal(skillQueryAtCaret("/skill:test", 11), null);
assert.equal(skillQueryAtCaret("/Users/work", 11), null);
assert.equal(skillQueryAtCaret("https://example", 15), null);

const skill = skillReference(["alpha", "beta"])!;
for (const displayReceipt of [true, false]) {
  const entries = [
    { type: "custom", id: "metadata", parentId: null, timestamp: new Date().toISOString(), customType: displayReceipt ? "display_user_message" : "turn_context", data: { content: "正文", skill } },
    { type: "message", id: "user", parentId: "metadata", timestamp: new Date().toISOString(), message: { role: "user", content: "正文", timestamp: Date.now() } },
  ] as SessionEntry[];
  const message = buildSessionContext(entries).messages[0] as UserMessage;
  assert.deepEqual(message.skill, skill, "both metadata paths must retain all skills after loading");
  const html = renderToStaticMarkup(<MessageView message={message} />);
  assert.match(html, /使用了技能: alpha/);
  assert.match(html, /使用了技能: beta/);
  assert.match(html, /正文/);
}
console.log("skill selection and history tests passed");
