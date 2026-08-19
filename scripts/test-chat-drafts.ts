import assert from "node:assert/strict";
import {
  ChatDraftStore,
  clearCwdScopedDraftResources,
  createChatDraftKey,
  promoteNewSessionDraft,
  type ChatDraftState,
} from "../lib/chat-drafts.ts";

type Draft = ChatDraftState & { marker?: string };

const emptyDraft = (): Draft => ({
  value: "",
  attachedImages: [],
  selectedSkill: null,
  fileReferences: [],
});

// 同一 session 在不同槽位中必须拥有独立草稿，不能相互覆盖。
{
  const drafts = new ChatDraftStore<Draft>();
  drafts.set(0, "same-session", { ...emptyDraft(), value: "槽位一" });
  drafts.set(1, "same-session", { ...emptyDraft(), value: "槽位二" });

  assert.notEqual(createChatDraftKey(0, "same-session"), createChatDraftKey(1, "same-session"));
  assert.equal(drafts.get(0, "same-session")?.value, "槽位一");
  assert.equal(drafts.get(1, "same-session")?.value, "槽位二");
}

// 存储独立于 ChatWindow 生命周期；重新读取同一槽位会话仍可恢复草稿。
{
  const drafts = new ChatDraftStore<Draft>();
  drafts.set(3, "session-a", { ...emptyDraft(), value: "布局缩减后仍应保留" });
  assert.equal(drafts.get(3, "session-a")?.value, "布局缩减后仍应保留");

  drafts.clear(3, "session-a");
  assert.equal(drafts.get(3, "session-a"), null, "显式关闭槽位必须清理对应草稿");
}

// 占位会话变为真实 session 时，仅延续尚未发送的文件引用，不能复活已发送的文本或图片。
{
  const placeholder: Draft = {
    value: "已发送内容",
    attachedImages: [{ name: "sent-image" }],
    selectedSkill: { name: "sent-skill" },
    fileReferences: [{ path: "/work/keep.ts", name: "keep.ts" }],
  };
  const promoted = promoteNewSessionDraft(placeholder, null, emptyDraft);
  assert.deepEqual(promoted, {
    value: "",
    attachedImages: [],
    selectedSkill: null,
    fileReferences: [{ path: "/work/keep.ts", name: "keep.ts" }],
  });

  const existing: Draft = { ...emptyDraft(), fileReferences: [{ path: "/work/current.ts", name: "current.ts" }] };
  assert.equal(promoteNewSessionDraft(placeholder, existing, emptyDraft), existing, "真实会话已有引用时不可覆盖");
}

// 切换新会话项目时，只保留与项目无关的文本，不得携带图片、文件引用或技能。
{
  const original: Draft = {
    value: "保留这段需求文本",
    attachedImages: [{ path: "/projects/a/image.png" }],
    selectedSkill: { name: "project-a-skill" },
    fileReferences: [{ path: "/projects/a/src/index.ts", name: "index.ts" }],
  };
  assert.deepEqual(clearCwdScopedDraftResources(original), {
    value: "保留这段需求文本",
    attachedImages: [],
    selectedSkill: null,
    fileReferences: [],
  });
}

console.log("chat draft tests passed");
