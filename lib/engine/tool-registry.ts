/**
 * ToolRegistry —— 工具注册的单一数据源（M2 产出，消灭 H6/H7/H8/H9）。
 *
 * 背景（设计文档 §二 H6/H7/H8/H9 + §4.3）：
 * pi 内部维护了 **三份** 工具副本（`_toolRegistry` / `_toolDefinitions` /
 * `agent.state.tools`），DeerHux 想设置单工具 executionMode 时必须三处同步写入，
 * 想热替换 MCP 工具时必须直接改私有 `_customTools` + `_allowedToolNames` +
 * 调私有 `_refreshToolRegistry`。自研 loop 把这三份副本合并成 ToolRegistry 这
 * **一个** Map，所有读写都走公开方法。
 *
 * 职责：
 * 1. 维护「全部已注册工具」（Map<name, ToolDefinition>）
 * 2. 维护「当前激活工具白名单」（Set<name>，仅白名单内的工具暴露给 LLM）
 * 3. 维护「每工具 executionMode 覆盖」（Map<name, mode>，覆盖工具自带的 executionMode）
 * 4. 提供原子热替换（{@link replaceBatch}，消灭 H9）
 *
 * 注意：本类不执行工具，只管元数据。执行交给 {@link ToolExecutor}。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolExecutionMode } from "./loop-event.ts";

/**
 * 不带泛型参数的 ToolDefinition 别名。
 *
 * pi-coding-agent 的 `ToolDefinition<TParams, TDetails, TState>` 是三参泛型，
 * Map 里只能存「擦除泛型」的版本。用 `ToolDefinition<any, any, any>` 后，
 * execute 的 params 形参类型 = Static<any> = any，调用时传 any 安全。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any, any>;

/**
 * 热替换批操作选项（消灭 H9）。
 *
 * 对应 rpc-manager.installMcpRuntime 里对 pi 私有字段 `_customTools` /
 * `_allowedToolNames` / `_refreshToolRegistry` 的原子操作。这里一次调用完成
 * 「移除旧工具 + 注册新工具 + 重设白名单」，避免中间态被 LLM 看见。
 */
export interface ReplaceBatchOptions {
  /** 要从已注册集合中移除的工具名（通常是上一轮的 MCP 工具名）。 */
  removeNames: readonly string[];
  /** 新增的工具定义。 */
  addTools: readonly AnyToolDefinition[];
  /** 重设后的激活白名单（仅这些工具暴露给 LLM）。 */
  activeToolNames: readonly string[];
  /** 需要无条件加入白名单的额外名字（即使未注册也保留，便于先占位）。 */
  extraAllowedNames?: readonly string[];
}

/**
 * 工具注册表。一个实例 = 一个 loop 会话的工具元数据全集。
 *
 * 线程安全说明：DeerHux 是单线程 JS，且 prompt() 串行（M1 已禁止并发 prompt），
 * 所以 register/unregister/replaceBatch 不需要锁。唯一的竞态是「工具执行期间
 * 热替换」——M2 的处理是：执行器在调用 executeBatch 前已把本次要用的 ToolDefinition
 * 数组快照下来（getActive() 返回数组拷贝），执行期间 registry 变更不影响在跑的批次。
 */
export class ToolRegistry {
  /** 全部已注册工具（name → definition）。 */
  private readonly tools = new Map<string, AnyToolDefinition>();

  /** 当前激活白名单（仅这些 name 对应的工具暴露给 LLM）。 */
  private readonly activeNames = new Set<string>();

  /** 单工具 executionMode 覆盖（优先于工具自带的 executionMode）。 */
  private readonly executionModes = new Map<string, ToolExecutionMode>();

  /** 全局默认 executionMode（工具既无自带 mode 也无覆盖时用）。 */
  private defaultMode: ToolExecutionMode = "parallel";

  /** 注册一个工具。同名覆盖（防重名靠 name 唯一性保证）。 */
  register(tool: AnyToolDefinition): void {
    if (!tool || typeof tool.name !== "string" || tool.name.length === 0) {
      throw new Error("ToolRegistry.register: tool.name 必须是非空字符串");
    }
    if (typeof tool.execute !== "function") {
      throw new Error(`ToolRegistry.register: tool "${tool.name}" 缺少 execute 函数`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 批量注册。 */
  registerAll(tools: readonly AnyToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  /** 注销工具（按名）。同时清掉白名单与 mode 覆盖。 */
  unregister(name: string): void {
    this.tools.delete(name);
    this.activeNames.delete(name);
    this.executionModes.delete(name);
  }

  /** 是否已注册。 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 是否已注册且位于当前激活白名单。执行阶段必须再次校验，不能信任模型输出。 */
  isActive(name: string): boolean {
    return this.activeNames.has(name) && this.tools.has(name);
  }

  /** 取单个工具定义（未注册返回 undefined）。 */
  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** 全部已注册工具（数组拷贝，外部修改不影响内部）。 */
  getAll(): AnyToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** 当前激活的工具定义（= 白名单 ∩ 已注册，数组拷贝）。 */
  getActive(): AnyToolDefinition[] {
    const result: AnyToolDefinition[] = [];
    for (const name of this.activeNames) {
      const tool = this.tools.get(name);
      if (tool) result.push(tool);
    }
    return result;
  }

  /** 当前激活工具名（数组拷贝，保持插入序）。 */
  getActiveNames(): string[] {
    const result: string[] = [];
    for (const name of this.activeNames) {
      if (this.tools.has(name)) result.push(name);
    }
    return result;
  }

  /**
   * 重设激活白名单。
   *
   * 语义：仅把「已注册」的 name 纳入白名单（未注册的静默忽略，防 LLM 看到幽灵工具）。
   * 传空数组 = 关闭所有工具（LLM 看不到任何工具）。
   */
  setActive(names: readonly string[]): void {
    this.activeNames.clear();
    for (const name of names) {
      if (this.tools.has(name)) {
        this.activeNames.add(name);
      }
    }
  }

  /** 设置单工具 executionMode 覆盖（消灭 H6/H7/H8 的三处补丁）。 */
  setExecutionMode(name: string, mode: ToolExecutionMode): void {
    this.executionModes.set(name, mode);
  }

  /** 批量设置 executionMode（name → mode）。 */
  setExecutionModes(map: Record<string, ToolExecutionMode>): void {
    for (const [name, mode] of Object.entries(map)) {
      this.executionModes.set(name, mode);
    }
  }

  /** 取某工具的有效 executionMode（覆盖 > 自带 > 默认）。 */
  getExecutionMode(name: string): ToolExecutionMode {
    const override = this.executionModes.get(name);
    if (override) return override;
    const tool = this.tools.get(name);
    if (tool?.executionMode) return tool.executionMode;
    return this.defaultMode;
  }

  /** 设置全局默认 executionMode。 */
  setDefaultExecutionMode(mode: ToolExecutionMode): void {
    this.defaultMode = mode;
  }

  /** 取全局默认 executionMode。 */
  getDefaultExecutionMode(): ToolExecutionMode {
    return this.defaultMode;
  }

  /**
   * 原子热替换（消灭 H9）。
   *
   * 一次调用完成：① 移除 removeNames ② 注册 addTools ③ 重设白名单
   *（activeToolNames ∪ extraAllowedNames，再 ∩ 已注册）。
   *
   * 顺序很重要：先移除旧工具，再注册新工具，最后用「新工具集」过滤白名单，
   * 保证白名单里不会残留已移除的名字。
   */
  replaceBatch(options: ReplaceBatchOptions): void {
    // ① 移除旧工具（同时清掉它们的白名单与 mode 覆盖）。
    for (const name of options.removeNames) {
      this.unregister(name);
    }

    // ② 注册新工具。
    this.registerAll(options.addTools);

    // ③ 重设白名单：activeToolNames ∪ extraAllowedNames，再 ∩ 已注册。
    const wanted = new Set<string>([
      ...options.activeToolNames,
      ...(options.extraAllowedNames ?? []),
    ]);
    this.activeNames.clear();
    for (const name of wanted) {
      if (this.tools.has(name)) {
        this.activeNames.add(name);
      }
    }
  }

  /** 清空全部（测试 / dispose 用）。 */
  clear(): void {
    this.tools.clear();
    this.activeNames.clear();
    this.executionModes.clear();
    this.defaultMode = "parallel";
  }
}
