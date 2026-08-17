import {
  AuthStorage,
  buildSessionContext,
  DefaultResourceLoader,
  defineTool,
  formatSkillsForPrompt,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Message as PiMessage, ThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getToolNamesForAgentMode, normalizeAgentMode, type AgentMode } from "../agent-modes";
import { indexExists } from "../code-index/database";
import { searchIndex } from "../code-index/search";
import { createCodeGraphTools } from "../codegraph/tools";
import type { LlmRequestKind } from "../llm-gateway";
import type { McpRuntimeLease } from "../mcp-runtime";
import { createSubagentTool } from "../parallel-agent/subagent-tool";
import { createStandardCodingTools, STANDARD_CODING_TOOL_NAMES } from "./coding-tools";
import { getContextDir } from "./context-archive";
import { deerLoopEngineFactory } from "./deer-loop-engine-factory";
import {
  computeActiveToolNames,
  selectModelRef,
  shouldLoadMcpRuntime,
  type ModelSelectionRef,
} from "./composition-policy";
import type { DeerLoopOptions } from "./deer-loop";
import type { AgentEngineFactoryPort, AgentEnginePort } from "./port";
import type { AnyToolDefinition } from "./tool-registry";
import { PiSessionAdapter } from "../session/pi-session-adapter";
import type { AgentSessionPort } from "../session/port";
import { PiModelCatalogAdapter } from "../model/pi-model-catalog-adapter";
import type { ModelCatalogPort } from "../model/port";
import { addAllowedRoot } from "../file-access";
import { PiProjectResourceAdapter } from "../project-resource/pi-project-resource-adapter";
import type { ProjectResourcePort } from "../project-resource/port";

export interface DeerLoopCompositionOptions {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  toolNames?: string[];
  agentMode?: AgentMode | null;
  modelOverride?: { provider: string; modelId: string };
  allowSubagentTool?: boolean;
  maxToolRounds?: number;
  requestKind?: LlmRequestKind;
}

export interface DeerLoopCompositionDependencies {
  createSession(cwd: string): SessionManager;
  openSession(file: string): SessionManager;
  createModelRegistry(): ModelRegistry;
  getDefaultModel(cwd: string): ModelSelectionRef | undefined;
  acquireMcpRuntime(cwd: string): Promise<McpRuntimeLease>;
  loadSystemPrompt(cwd: string, includeSkills: boolean): Promise<string>;
  createStandardTools(cwd: string, sessionId: string): AnyToolDefinition[];
  createCodeGraphTools(cwd: string): Promise<AnyToolDefinition[]>;
  hasCodeIndex(cwd: string): boolean;
  createSubagentTool: typeof createSubagentTool;
  createProjectResources(): ProjectResourcePort;
}

export interface ComposedDeerLoopEngine {
  engine: AgentEnginePort;
  sessionPort: AgentSessionPort;
  modelCatalog: ModelCatalogPort;
  projectResources: ProjectResourcePort;
  realSessionId: string;
  realSessionFile?: string;
  mcpRuntimeLease: McpRuntimeLease | null;
  explicitMode?: AgentMode;
}

interface BaseSystemPromptResources {
  cwd: string;
  customPrompt?: string;
  appendSystemPrompt?: string[];
  contextFiles?: Array<{ path: string; content: string }>;
  formattedSkills?: string;
  now?: Date;
}

function composeBaseSystemPrompt(resources: BaseSystemPromptResources): string {
  const basePrompt = resources.customPrompt?.trim() || [
    "You are an expert coding assistant operating inside DeerHux, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
    "Available tools:\n(none)",
    "Guidelines:\n- Be concise in your responses\n- Show file paths clearly when working with files",
  ].join("\n\n");
  const parts = [basePrompt];
  const appendPrompt = resources.appendSystemPrompt
    ?.map((item) => item.trim())
    .filter(Boolean)
    .join("\n\n");
  if (appendPrompt) parts.push(appendPrompt);
  if (resources.contextFiles?.length) {
    const context = resources.contextFiles
      .map(({ path: filePath, content }) => (
        `<project_instructions path="${filePath}">\n${content}\n</project_instructions>`
      ))
      .join("\n\n");
    parts.push(`<project_context>\n\nProject-specific instructions and guidelines:\n\n${context}\n\n</project_context>`);
  }
  if (resources.formattedSkills?.trim()) parts.push(resources.formattedSkills.trim());
  const now = resources.now ?? new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  parts.push(`Current date: ${date}\nCurrent working directory: ${resources.cwd.replace(/\\/g, "/")}`);
  return parts.join("\n\n");
}

async function loadBaseSystemPrompt(cwd: string, includeSkills: boolean): Promise<string> {
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await loader.reload();
  const skills = includeSkills ? loader.getSkills().skills : [];
  return composeBaseSystemPrompt({
    cwd,
    customPrompt: loader.getSystemPrompt(),
    appendSystemPrompt: loader.getAppendSystemPrompt(),
    contextFiles: loader.getAgentsFiles().agentsFiles,
    formattedSkills: skills.length ? formatSkillsForPrompt(skills) : undefined,
  });
}

const defaultCompositionDependencies: DeerLoopCompositionDependencies = {
  createSession: (cwd) => SessionManager.create(cwd, undefined),
  openSession: (file) => SessionManager.open(file, undefined),
  createModelRegistry: () => ModelRegistry.create(AuthStorage.create()),
  getDefaultModel: (cwd) => {
    const settings = SettingsManager.create(cwd, getAgentDir());
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    return provider && modelId ? { provider, modelId } : undefined;
  },
  acquireMcpRuntime: (cwd) => import("../mcp-runtime").then(({ acquireMcpRuntime }) => acquireMcpRuntime(cwd)),
  loadSystemPrompt: loadBaseSystemPrompt,
  createStandardTools: (cwd, sessionId) => createStandardCodingTools(cwd, { sessionId }),
  createCodeGraphTools,
  hasCodeIndex: indexExists,
  createSubagentTool,
  createProjectResources: () => new PiProjectResourceAdapter(),
};

/**
 * DeerLoop 的 composition root：发现运行时资源并通过可替换工厂创建引擎。
 * Wrapper、注册表、别名与 SSE 生命周期不属于这里，继续由 rpc-manager 管理。
 */
export async function composeDeerLoopEngine(
  options: DeerLoopCompositionOptions,
  factory: AgentEngineFactoryPort<DeerLoopOptions> = deerLoopEngineFactory,
  overrides: Partial<DeerLoopCompositionDependencies> = {},
): Promise<ComposedDeerLoopEngine> {
  const dependencies = { ...defaultCompositionDependencies, ...overrides };
  const modelRegistry = dependencies.createModelRegistry();
  const sessionManager = options.sessionFile
    ? dependencies.openSession(options.sessionFile)
    : dependencies.createSession(options.cwd);
  const restoredContext = options.sessionFile
    ? buildSessionContext(sessionManager.getEntries(), sessionManager.getLeafId())
    : null;
  const restoredModel = restoredContext?.model
    ? { provider: restoredContext.model.provider, modelId: restoredContext.model.modelId }
    : undefined;
  const restoredThinkingLevel = restoredContext?.thinkingLevel;
  const initialMessages = (restoredContext?.messages ?? []) as PiMessage[];

  const selectedModel = selectModelRef({
    explicit: options.modelOverride,
    restored: restoredModel,
    environment: process.env.DEERHUX_LOOP_MODEL,
    configuredDefault: dependencies.getDefaultModel(options.cwd),
  });
  let model = selectedModel
    ? modelRegistry.find(selectedModel.provider, selectedModel.modelId)
    : undefined;
  if (options.modelOverride && !model) {
    throw new Error(`Model not found: ${options.modelOverride.provider}/${options.modelOverride.modelId}`);
  }
  model ??= modelRegistry.getAvailable()[0];
  if (!model) {
    throw new Error(
      "DeerLoopEngine 启动失败：未找到可用 model。请在 ~/.deerhux/agent 配置 API key，" +
      "或设 DEERHUX_LOOP_MODEL=provider/modelId 指定模型。",
    );
  }

  const realSessionId = sessionManager.getSessionId();
  const standardCodingTools = dependencies.createStandardTools(options.cwd, realSessionId);
  try {
    addAllowedRoot(getContextDir(realSessionId));
  } catch {
    // context archive 白名单失败不阻塞会话启动
  }

  const hasCodeIndex = dependencies.hasCodeIndex(options.cwd);
  const codeSearchTool = hasCodeIndex ? defineTool({
    name: "code_search",
    label: "Code Search",
    description: "Search the codebase using a pre-built index. Returns file paths, line ranges, and concise code snippets.",
    promptSnippet: "code_search: Search the indexed codebase by keywords and get file paths, line ranges, and snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query keywords" }),
      path: Type.Optional(Type.String({ description: "Restrict to files under this relative path" })),
      limit: Type.Optional(Type.Number({ description: "Maximum results, default 20" })),
    }),
    executionMode: "parallel" as const,
    execute: async (_toolCallId, params, signal) => {
      const results = await searchIndex(options.cwd, params.query, {
        path: params.path,
        limit: params.limit ?? 20,
        signal,
      });
      const text = results.length
        ? results.map((result) => `${result.path}:${result.startLine}-${result.endLine} (score ${result.score})\n${result.snippet}`).join("\n\n")
        : `No indexed results for: ${params.query}`;
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  }) : null;
  const codeGraphTools = await dependencies.createCodeGraphTools(options.cwd);

  const sessionContext: { engine?: AgentEnginePort } = {};
  const subagentTool = options.allowSubagentTool !== false ? dependencies.createSubagentTool(options.cwd, {
    getParentSessionId: () => realSessionId,
    getParentEntryId: () => sessionManager.getLeafId() ?? undefined,
    getParentModel: () => {
      const current = sessionContext.engine?.model;
      return current ? { provider: String(current.provider), modelId: String(current.id ?? "") } : undefined;
    },
  }) : null;

  const hasExplicitMode = options.agentMode !== undefined && options.agentMode !== null;
  const effectiveMode = normalizeAgentMode(options.agentMode);
  const requestedToolNames = options.toolNames
    ?? (hasExplicitMode ? getToolNamesForAgentMode(effectiveMode) : []);
  const shouldLoadMcp = shouldLoadMcpRuntime(requestedToolNames, hasExplicitMode);
  const mcpRuntimeLease = shouldLoadMcp
    ? await dependencies.acquireMcpRuntime(options.cwd)
    : null;
  const mcpRuntime = mcpRuntimeLease?.runtime ?? null;

  try {
    const tools: AnyToolDefinition[] = [
    ...standardCodingTools,
    ...(codeSearchTool ? [codeSearchTool] : []),
    ...codeGraphTools,
    ...(subagentTool ? [subagentTool] : []),
    ...(mcpRuntime?.tools ?? []),
  ];
  const availableToolNames = [
    ...STANDARD_CODING_TOOL_NAMES,
    ...(codeSearchTool ? ["code_search"] : []),
    ...codeGraphTools.map((tool) => tool.name),
    ...(mcpRuntime?.toolNames ?? []),
  ];

  const activeToolNames = computeActiveToolNames({
    requestedToolNames,
    availableToolNames,
    hasExplicitSelection: options.toolNames !== undefined,
    hasExplicitMode,
  });

  const systemPrompt = await dependencies.loadSystemPrompt(options.cwd, activeToolNames.includes("read"));

  const sessionPort = new PiSessionAdapter(sessionManager);
  const modelCatalog = new PiModelCatalogAdapter(modelRegistry);
  const projectResources = dependencies.createProjectResources();
  // 新会话在首个 prompt 前就写入模型事实，确保刷新、Fork 和分支恢复一致。
  if (!options.sessionFile) sessionPort.appendModelChange(model.provider, model.id);

  const engine = factory.create({
    model,
    cwd: options.cwd,
    sessionId: realSessionId,
    systemPrompt,
    initialMessages,
    thinkingLevel: restoredThinkingLevel && restoredThinkingLevel !== "off"
      ? restoredThinkingLevel as ThinkingLevel
      : undefined,
    getApiKey: (provider) => modelRegistry.getApiKeyForProvider(provider),
    sessionManager,
    sessionPort,
    modelRegistry,
    modelCatalog,
    tools,
    activeToolNames,
    maxToolRounds: options.maxToolRounds,
    requestKind: options.requestKind,
  });
  sessionContext.engine = engine;

    return {
      engine,
      sessionPort,
      modelCatalog,
      projectResources,
      realSessionId,
      realSessionFile: sessionManager.getSessionFile?.() ?? undefined,
      mcpRuntimeLease,
      explicitMode: hasExplicitMode ? effectiveMode : undefined,
    };
  } catch (error) {
    mcpRuntimeLease?.release();
    throw error;
  }
}
