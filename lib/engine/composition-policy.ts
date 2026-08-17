export interface ModelSelectionRef {
  provider: string;
  modelId: string;
}

export function selectModelRef(options: {
  explicit?: ModelSelectionRef;
  restored?: ModelSelectionRef;
  environment?: string;
  configuredDefault?: ModelSelectionRef;
}): ModelSelectionRef | undefined {
  if (options.explicit) return options.explicit;
  if (options.restored) return options.restored;
  const [provider, modelId] = options.environment?.split("/") ?? [];
  if (provider && modelId) return { provider, modelId };
  return options.configuredDefault;
}

const FULL_PRESET_MARKERS = ["bash", "edit", "write", "grep", "find", "ls"];

export function isFullToolPreset(toolNames: readonly string[]): boolean {
  return FULL_PRESET_MARKERS.every((name) => toolNames.includes(name));
}

export function shouldLoadMcpRuntime(
  requestedToolNames: readonly string[],
  hasExplicitMode: boolean,
): boolean {
  return (!hasExplicitMode && isFullToolPreset(requestedToolNames))
    || requestedToolNames.some((name) => name.startsWith("mcp__"));
}

export function computeActiveToolNames(options: {
  requestedToolNames: readonly string[];
  availableToolNames: readonly string[];
  hasExplicitSelection: boolean;
  hasExplicitMode: boolean;
}): string[] {
  const { requestedToolNames, availableToolNames, hasExplicitSelection, hasExplicitMode } = options;
  if (!hasExplicitSelection && !hasExplicitMode) return [...availableToolNames];
  if (requestedToolNames.length === 0) return [];
  if (!hasExplicitMode && isFullToolPreset(requestedToolNames)) return [...availableToolNames];
  const available = new Set(availableToolNames);
  return requestedToolNames.filter((name) => available.has(name));
}
