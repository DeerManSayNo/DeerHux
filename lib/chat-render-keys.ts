export function getChatRenderKey(
  renderKeys: ReadonlyMap<string, string>,
  sessionId: string,
): string {
  return renderKeys.get(sessionId) ?? sessionId;
}

export function promoteChatRenderKey(
  renderKeys: Map<string, string>,
  previousSessionId: string | null | undefined,
  nextSessionId: string,
): void {
  if (!previousSessionId || previousSessionId === nextSessionId) return;
  const renderKey = getChatRenderKey(renderKeys, previousSessionId);
  renderKeys.delete(previousSessionId);
  renderKeys.set(nextSessionId, renderKey);
}
