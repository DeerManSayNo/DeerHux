import assert from "node:assert/strict";
import { getTextContentPhase, hasExplicitFinalAnswerStarted } from "../lib/text-content-phase.ts";

const signature = (phase?: string, version = 1) => JSON.stringify({
  v: version,
  id: "msg_1",
  ...(phase ? { phase } : {}),
});

assert.equal(getTextContentPhase({ type: "text", text: "继续检查", textSignature: signature("commentary") }), "commentary");
assert.equal(getTextContentPhase({ type: "text", text: "处理完成", textSignature: signature("final_answer") }), "final_answer");
assert.equal(getTextContentPhase({ type: "text", text: "旧模型输出" }), null);
assert.equal(getTextContentPhase({ type: "text", text: "未知阶段", textSignature: signature("other") }), null);
assert.equal(getTextContentPhase({ type: "text", text: "未来版本", textSignature: signature("final_answer", 2) }), null);
assert.equal(getTextContentPhase({ type: "text", text: "非法签名", textSignature: "{" }), null);

assert.equal(hasExplicitFinalAnswerStarted([
  { type: "text", text: "继续检查", textSignature: signature("commentary") },
]), false);
assert.equal(hasExplicitFinalAnswerStarted([
  { type: "text", text: "继续检查", textSignature: signature("commentary") },
  { type: "text", text: "处理完成", textSignature: signature("final_answer") },
]), true);
assert.equal(hasExplicitFinalAnswerStarted([
  { type: "text", text: "旧模型输出" },
]), false);
assert.equal(hasExplicitFinalAnswerStarted([
  { type: "text", text: "   ", textSignature: signature("final_answer") },
]), false);

console.log("text content phase tests passed");
