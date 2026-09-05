"use client";

import { useCallback, useRef } from "react";
import { getChatAutoScrollUpdate } from "./chatAutoScrollPolicy";

export { getChatAutoScrollUpdate } from "./chatAutoScrollPolicy";
export type { ChatAutoScrollAction, ChatAutoScrollState } from "./chatAutoScrollPolicy";

/**
 * 聊天会话的低层自动滚动 DOM/ref 状态。
 * 不管理消息、SSE 或运行状态；调用方仍在原有 effect 时机调用
 * syncAfterMessageChange，以保证原来的滚动调度顺序不变。
 */
export function useChatAutoScroll() {
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = scrollContainerRef.current;
    if (!container) return;
    // 首次加载的后台卡片也会执行这里；scrollIntoView 会把抽屉的横向
    // 会话列表一起滚到该卡片，导致第一次唤起时错位。
    container.scrollTo({
      top: Math.max(0, container.scrollHeight - container.clientHeight),
      behavior,
    });
  }, []);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: elAbsTop - 16, behavior: "smooth" });
  }, []);

  const resetAutoScroll = useCallback(() => {
    initialScrollDoneRef.current = false;
    pendingScrollToUserRef.current = false;
  }, []);

  const syncAfterMessageChange = useCallback((messageCount: number, agentRunning: boolean) => {
    const update = getChatAutoScrollUpdate(messageCount, {
      pendingScrollToUser: pendingScrollToUserRef.current,
      initialScrollDone: initialScrollDoneRef.current,
    }, agentRunning);

    pendingScrollToUserRef.current = update.state.pendingScrollToUser;
    initialScrollDoneRef.current = update.state.initialScrollDone;

    switch (update.action) {
      case "user-message":
        scrollUserMsgToTop();
        break;
      case "bottom-instant":
        scrollToBottom("instant");
        break;
    }
  }, [scrollToBottom, scrollUserMsgToTop]);

  return {
    messagesEndRef,
    scrollContainerRef,
    lastUserMsgRef,
    pendingScrollToUserRef,
    initialScrollDoneRef,
    resetAutoScroll,
    syncAfterMessageChange,
  };
}
