import type { AgentMessage, AssistantContentBlock, ToolCallContent, ToolResultMessage } from "./types";

export interface StreamingToolGroup {
  id: string;
  closedByText: boolean;
  tools: { block: ToolCallContent; timestamp?: number }[];
}

export interface StreamingToolMessageLayout {
  hiddenToolIds: Set<string>;
  groups: Map<string, StreamingToolGroup>;
}

/** 共享正文分段规则，完成态将末尾工具段也全部收起。 */
function buildToolLayout(
  messages: AgentMessage[],
  streamingMessage: Partial<AgentMessage> | null,
  isRunning: boolean,
  collapseAll = false,
) {
  const byMessage = new Map<number, StreamingToolMessageLayout>();
  const hiddenMessageIndexes = new Set<number>();
  if (!isRunning) return { byMessage, hiddenMessageIndexes };

  let start = messages.length - 1;
  while (start >= 0 && messages[start].role !== "user") start--;
  const source: Partial<AgentMessage>[] = [...messages, ...(streamingMessage ? [streamingMessage] : [])];
  const seen = new Set<string>();
  let segment: { block: ToolCallContent; timestamp?: number; messageIndex: number }[] = [];
  const layoutFor = (index: number) => {
    let layout = byMessage.get(index);
    if (!layout) {
      layout = { hiddenToolIds: new Set(), groups: new Map() };
      byMessage.set(index, layout);
    }
    return layout;
  };
  const flush = (closedByText: boolean) => {
    const hidden = segment;
    if (hidden.length) {
      const first = hidden[0];
      layoutFor(first.messageIndex).groups.set(first.block.toolCallId, {
        id: first.block.toolCallId,
        closedByText,
        tools: hidden.map(({ block, timestamp }) => ({ block, timestamp })),
      });
      for (const tool of hidden) layoutFor(tool.messageIndex).hiddenToolIds.add(tool.block.toolCallId);
    }
    segment = [];
  };

  for (let index = start + 1; index < source.length; index++) {
    const message = source[index];
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) flush(true);
      if (block.type !== "toolCall") continue;
      if (seen.has(block.toolCallId)) {
        // 流式消息与持久化快照短暂重叠时，同一调用只显示一次。
        layoutFor(index).hiddenToolIds.add(block.toolCallId);
        continue;
      }
      seen.add(block.toolCallId);
      segment.push({ block, timestamp: message.timestamp, messageIndex: index });
    }
  }
  flush(collapseAll);

  for (const [index, layout] of byMessage) {
    const message = source[index];
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (!message.content.some((block: AssistantContentBlock) => {
      if (block.type === "toolCall") return layout.groups.has(block.toolCallId) || !layout.hiddenToolIds.has(block.toolCallId);
      if (block.type === "text") return Boolean(block.text.trim());
      if (block.type === "thinking") return index === messages.length && Boolean(streamingMessage) && Boolean(block.thinking.trim());
      return true;
    }) && !message.errorMessage) hiddenMessageIndexes.add(index);
  }
  return { byMessage, hiddenMessageIndexes };
}

/** 结果尚未同步不代表仍在执行；只认运行事件维护的 active IDs。 */
export function countRunningGroupTools(
  group: StreamingToolGroup,
  activeToolIds?: ReadonlySet<string>,
  results?: ReadonlyMap<string, ToolResultMessage>,
): number {
  return group.tools.filter(({ block }) =>
    activeToolIds?.has(block.toolCallId) && !results?.has(block.toolCallId),
  ).length;
}

/** 只派生当前运行回合的显示方式，不修改消息或工具结果。 */
export function buildStreamingToolLayout(messages: AgentMessage[], streamingMessage: Partial<AgentMessage> | null, isRunning: boolean) {
  return buildToolLayout(messages, streamingMessage, isRunning);
}

/** 传入单轮过程消息；展开历史过程时每个工具段仍默认收起。 */
export function buildCompletedToolLayout(messages: AgentMessage[]) {
  return buildToolLayout(messages, null, true, true);
}

const TOOL_ACTIVITIES: Record<string, { summary: string; current: string }> = {
  read: { summary: "读取文件", current: "读取文件" },
  bash: { summary: "运行了命令", current: "运行命令" },
  edit: { summary: "修改文件", current: "修改文件" },
  write: { summary: "写入文件", current: "写入文件" },
  grep: { summary: "搜索内容", current: "搜索内容" },
  code_search: { summary: "搜索内容", current: "搜索内容" },
  codegraph: { summary: "查询代码关系", current: "查询代码关系" },
  find: { summary: "查找文件", current: "查找文件" },
  ls: { summary: "查看目录", current: "查看目录" },
};

/** Classify declared tools, never guess command effects from shell text. */
export function summarizeToolActivities(tools: readonly ToolCallContent[]): string {
  const categories = new Set(tools.map((tool) => TOOL_ACTIVITIES[tool.toolName]?.summary ?? "调用其他工具"));
  const order = ["读取文件", "查看目录", "查找文件", "搜索内容", "查询代码关系", "修改文件", "写入文件", "运行了命令", "调用其他工具"];
  const labels = order.filter((label) => categories.has(label));
  if (!labels.length) return "已处理";
  if (labels.length === 1) return labels[0] === "运行了命令" ? labels[0] : `已${labels[0]}`;
  return `已${labels.slice(0, -1).join("、")}并${labels.at(-1)}`;
}

export function currentToolActivity(tool: ToolCallContent): string {
  return TOOL_ACTIVITIES[tool.toolName]?.current ?? `调用 ${tool.toolName}`;
}

/** Move the open segment into the bottom status area, retaining message usage rows. */
export function moveCurrentToolGroupToBottom(layout: ReturnType<typeof buildStreamingToolLayout>) {
  const byMessage = new Map(layout.byMessage);
  let bottomGroup: StreamingToolGroup | undefined;
  for (const [index, messageLayout] of byMessage) {
    for (const [id, group] of messageLayout.groups) {
      if (group.closedByText) continue;
      bottomGroup = group;
      const groups = new Map(messageLayout.groups);
      groups.delete(id);
      byMessage.set(index, { ...messageLayout, groups });
    }
  }
  return { ...layout, byMessage, bottomGroup };
}
