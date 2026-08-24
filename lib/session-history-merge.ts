function getClientMessageId(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || !("clientMessageId" in message)) return undefined;
  const value = message.clientMessageId;
  return typeof value === "string" && value ? value : undefined;
}

export function mergeFullSessionHistory<T>(
  loadedMessages: T[],
  loadedEntryIds: string[],
  currentMessages: T[],
  currentEntryIds: string[],
): { messages: T[]; entryIds: string[] } {
  const messages = [...loadedMessages];
  const entryIds = [...loadedEntryIds];
  const knownEntryIds = new Set(loadedEntryIds.filter(Boolean));
  const knownClientMessageIds = new Set(
    loadedMessages.map(getClientMessageId).filter((id): id is string => Boolean(id)),
  );

  currentMessages.forEach((message, index) => {
    const entryId = currentEntryIds[index] ?? "";
    const clientMessageId = getClientMessageId(message);
    if (entryId && knownEntryIds.has(entryId)) return;
    if (!entryId && clientMessageId && knownClientMessageIds.has(clientMessageId)) return;

    messages.push(message);
    entryIds.push(entryId);
    if (entryId) knownEntryIds.add(entryId);
    if (clientMessageId) knownClientMessageIds.add(clientMessageId);
  });

  return { messages, entryIds };
}
