
/** 输入草稿的最小共享结构，避免草稿存储依赖 React 或 DOM。 */
export interface ChatDraftState {
  value: string;
  attachedImages: unknown[];
  selectedSkill: unknown | null;
  fileReferences?: { path: string; name: string }[];
}

/**
 * 同一会话可能在多个槽位中独立显示；槽位编号是草稿身份的一部分。
 * JSON 编码避免 session id 中的分隔符造成键碰撞。
 */
export function createChatDraftKey(slotIndex: number, sessionId: string): string {
  return JSON.stringify([slotIndex, sessionId]);
}

export class ChatDraftStore<T extends ChatDraftState> {
  private readonly drafts = new Map<string, T>();

  get(slotIndex: number, sessionId: string): T | null {
    return this.drafts.get(createChatDraftKey(slotIndex, sessionId)) ?? null;
  }

  set(slotIndex: number, sessionId: string, draft: T): void {
    this.drafts.set(createChatDraftKey(slotIndex, sessionId), draft);
  }

  clear(slotIndex: number, sessionId: string): void {
    this.drafts.delete(createChatDraftKey(slotIndex, sessionId));
  }
}

export function clearCwdScopedDraftResources<T extends ChatDraftState>(draft: T): T {
  return {
    ...draft,
    attachedImages: [],
    selectedSkill: null,
    fileReferences: [],
  };
}

/**
 * 新会话发送首条消息后会由占位 id 切换为真实 session id。
 * 发送后的文本和图片已按原有规则清空，只保留文件引用供新会话继续使用。
 */
export function promoteNewSessionDraft<T extends ChatDraftState>(
  placeholderDraft: T | null,
  sessionDraft: T | null,
  createEmptyDraft: () => T,
): T | null {
  if (!placeholderDraft?.fileReferences?.length || sessionDraft?.fileReferences?.length) {
    return sessionDraft;
  }

  return {
    ...(sessionDraft ?? createEmptyDraft()),
    fileReferences: placeholderDraft.fileReferences,
  };
}
