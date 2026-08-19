export type ChatAutoScrollAction = "user-message" | "bottom-instant" | null;

export interface ChatAutoScrollState {
  pendingScrollToUser: boolean;
  initialScrollDone: boolean;
}

/**
 * 保留消息数量变化时的既有滚动优先级，供 Hook 和 Node 回归测试共用。
 * 调用方负责在 action 非空时执行实际 DOM 滚动。
 */
export function getChatAutoScrollUpdate(
  messageCount: number,
  state: ChatAutoScrollState,
  _agentRunning: boolean,
): { action: ChatAutoScrollAction; state: ChatAutoScrollState } {
  if (messageCount === 0) return { action: null, state };

  if (state.pendingScrollToUser) {
    return {
      action: "user-message",
      state: { pendingScrollToUser: false, initialScrollDone: true },
    };
  }

  if (!state.initialScrollDone) {
    return {
      action: "bottom-instant",
      state: { ...state, initialScrollDone: true },
    };
  }

  // ChatWindow 已负责运行中消息的实时追底。流结束时，流式 bubble 会卸载、
  // 完成消息会写回历史列表；此处再对同一个嵌套滚动容器调用 scrollIntoView，
  // 会与实时滚动竞争，并可能导致浏览器直到下一次手动滚动才重绘内容。
  return { action: null, state };
}
