function getClientMessageId(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || !("clientMessageId" in message)) return undefined;
  const value = message.clientMessageId;
  return typeof value === "string" && value ? value : undefined;
}

// SSE message_end does not carry a persisted entry id. Match its exact message
// against the disk snapshot, never by text alone (users can repeat a prompt).
function getMessageFingerprint(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as { role?: unknown; timestamp?: unknown; content?: unknown; toolCallId?: unknown };
  if (typeof value.role !== "string" || typeof value.timestamp !== "number") return undefined;
  return JSON.stringify([value.role, value.timestamp, value.toolCallId, value.content]);
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
  const fingerprintCounts = new Map<string, number>();
  loadedMessages.forEach((message) => {
    const fingerprint = getMessageFingerprint(message);
    if (fingerprint) fingerprintCounts.set(fingerprint, (fingerprintCounts.get(fingerprint) ?? 0) + 1);
  });

  currentMessages.forEach((message, index) => {
    const entryId = currentEntryIds[index] ?? "";
    const clientMessageId = getClientMessageId(message);
    const fingerprint = getMessageFingerprint(message);
    const matchesById = Boolean(entryId && knownEntryIds.has(entryId))
      || Boolean(!entryId && clientMessageId && knownClientMessageIds.has(clientMessageId));
    const remaining = fingerprint ? fingerprintCounts.get(fingerprint) ?? 0 : 0;
    if (matchesById || (!entryId && remaining > 0)) {
      if (fingerprint && remaining > 0) fingerprintCounts.set(fingerprint, remaining - 1);
      return;
    }

    messages.push(message);
    entryIds.push(entryId);
    if (entryId) knownEntryIds.add(entryId);
    if (clientMessageId) knownClientMessageIds.add(clientMessageId);
  });

  return { messages, entryIds };
}
