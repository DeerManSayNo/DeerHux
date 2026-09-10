import { randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { AuthStorage, ModelRegistry, getAgentDir, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deerLoopEngineFactory } from "../engine/deer-loop-engine-factory";
import type { AgentEnginePort } from "../engine/port";
import { composeRolePrompt, readRoles } from "../roles";
import { normalizeToolCalls } from "../normalize";
import type { AgentMessage } from "../types";
import { SharedFiles } from "./files";

export class ShareError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export type ShareConfig = {
  name: string; projects: string[]; models: { provider: string; modelId: string }[];
  roleIds: string[]; writable: boolean; hours: number | null;
};
type Project = { id: string; name: string; root: string; roles: { id: string; name: string; prompt: string }[] };
export type Share = {
  id: string; name: string; projects: Project[]; models: ShareConfig["models"];
  writable: boolean; expiresAt: number | null; salt: Buffer; hash: Buffer; revoked: boolean;
  /** Owner-only display value; never include in the guest catalog. */
  ownerCode?: string;
};
type Guest = { shareId: string; id: string };
type Session = {
  id: string; shareId: string; guestId: string; projectId: string; roleId: string;
  model: ShareConfig["models"][number]; engine: AgentEnginePort; messages: AgentMessage[];
  partial?: AgentMessage; running: boolean; error?: string; name: string; turns: number; runtimeDirectory: string;
};

export function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new ShareError("请求包含不支持的字段");
  return value as Record<string, unknown>;
}

// Older in-memory shares only retained the hash. Explicit owner action replaces
// their code once; retries return the same value and do not rotate it again.
export function ensureOwnerCode(share: Share): string {
  if (share.ownerCode) return share.ownerCode;
  let code: string;
  do { code = randomInt(0, 1_000_000).toString().padStart(6, "0"); }
  while (timingSafeEqual(scryptSync(code, share.salt, 32), share.hash));
  const salt = randomBytes(16);
  const hash = scryptSync(code, salt, 32);
  Object.assign(share, { ownerCode: code, salt, hash });
  return code;
}

export class ShareService {
  constructor(
    private readonly registryFactory: () => Pick<ModelRegistry, "find" | "getApiKeyForProvider"> = () => ModelRegistry.create(AuthStorage.create()),
    private readonly engineFactory = deerLoopEngineFactory,
  ) {}
  readonly shares = new Map<string, Share>();
  private readonly guests = new Map<string, Guest>();
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, { count: number; until: number }>();

  create(raw: unknown): { share: Share; code: string } {
    const body = exactObject(raw, ["name", "projects", "models", "roleIds", "writable", "hours"]);
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80 || typeof body.writable !== "boolean" || (body.hours !== null && (typeof body.hours !== "number" || !Number.isFinite(body.hours) || body.hours < 1 || body.hours > 168))) throw new ShareError("请填写名称、权限及 1–168 小时或永久有效期");
    for (const key of ["projects", "models", "roleIds"]) if (!Array.isArray(body[key]) || body[key].length < 1 || body[key].length > 20) throw new ShareError("至少选择一个项目、模型和角色（各最多 20 个）");
    const config = body as unknown as ShareConfig;
    if (config.projects.some(p => typeof p !== "string") || config.roleIds.some(r => typeof r !== "string")) throw new ShareError("项目或角色无效");
    if (this.shares.size >= 20) throw new ShareError("最多创建 20 份分享，请先停止旧分享");
    const registry = this.registryFactory();
    const models = config.models.map(rawModel => {
      const model = exactObject(rawModel, ["provider", "modelId"]);
      if (typeof model.provider !== "string" || typeof model.modelId !== "string" || !registry.find(model.provider, model.modelId)) throw new ShareError("所选模型不可用");
      return { provider: model.provider, modelId: model.modelId };
    });
    const projects = [...new Set(config.projects)].map(root => {
      const files = new SharedFiles(root, () => false, () => {});
      if (config.writable) {
        // Editing this server's code in dev would execute changes through HMR,
        // bypassing the file-only tool boundary. Its configuration is protected too.
        const overlaps = (a: string, b: string) => {
          const rel = path.relative(a, b);
          return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
        };
        for (const protectedRoot of [process.cwd(), getAgentDir()]) {
          const canonical = realpathSync(protectedRoot);
          if (overlaps(files.root, canonical) || overlaps(canonical, files.root)) throw new ShareError("运行中的 DeerHux 代码及配置目录只能只读分享");
        }
      }
      const available = readRoles(files.root);
      const roles = [...new Set(config.roleIds)].map(id => {
        const role = available.find(r => r.id === id);
        if (!role) throw new ShareError("所选角色不适用于所有项目");
        return { id, name: role.name, prompt: composeRolePrompt(id, [], files.root) };
      });
      return { id: randomUUID(), root: files.root, name: path.basename(files.root), roles };
    });
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const salt = randomBytes(16);
    const share: Share = { id: randomUUID(), name: config.name.trim(), projects, models, writable: config.writable, expiresAt: config.hours === null ? null : Date.now() + config.hours * 3600_000, salt, hash: scryptSync(code, salt, 32), revoked: false, ownerCode: code };
    this.shares.set(share.id, share);
    return { share, code };
  }

  active(id: string): Share {
    const share = this.shares.get(id);
    if (!share || share.revoked || (share.expiresAt !== null && share.expiresAt <= Date.now())) throw new ShareError("分享已停止或过期", 410);
    return share;
  }

  login(id: string, code: unknown): string {
    const share = this.active(id);
    const now = Date.now();
    const attempt = this.attempts.get(id) ?? { count: 0, until: now + 60_000 };
    if (attempt.until <= now) { attempt.count = 0; attempt.until = now + 60_000; }
    this.attempts.set(id, attempt);
    if (++attempt.count > 10) throw new ShareError("尝试过多，请一分钟后重试", 429);
    if (typeof code !== "string" || !/^\d{6}$/.test(code.trim()) || !timingSafeEqual(scryptSync(code.trim(), share.salt, 32), share.hash)) throw new ShareError("匹配码不正确", 401);
    if ([...this.guests.values()].filter(g => g.shareId === id).length >= 30) throw new ShareError("访客数量已达上限", 429);
    const token = randomBytes(32).toString("hex");
    this.guests.set(token, { shareId: id, id: randomUUID() });
    return token;
  }

  guest(id: string, token: string | undefined): Guest {
    this.active(id);
    const guest = token ? this.guests.get(token) : undefined;
    if (!guest || guest.shareId !== id) throw new ShareError("请先输入匹配码", 401);
    return guest;
  }

  catalog(id: string) {
    const share = this.active(id);
    return { id, name: share.name, writable: share.writable, expiresAt: share.expiresAt, models: share.models,
      projects: share.projects.map(p => ({ id: p.id, name: p.name, roles: p.roles.map(r => ({ id: r.id, name: r.name })) })) };
  }

  list(guest: Guest) {
    return [...this.sessions.values()].filter(s => s.guestId === guest.id && s.shareId === guest.shareId)
      .map(s => ({ id: s.id, name: s.name, projectId: s.projectId, roleId: s.roleId, model: s.model, running: s.running }));
  }

  session(guest: Guest, id: string): Session {
    this.active(guest.shareId);
    const session = this.sessions.get(id);
    if (!session || session.guestId !== guest.id || session.shareId !== guest.shareId) throw new ShareError("会话不存在", 404);
    return session;
  }

  createSession(guest: Guest, raw: unknown) {
    const body = exactObject(raw, ["projectId", "roleId", "provider", "modelId"]);
    const share = this.active(guest.shareId);
    const project = share.projects.find(p => p.id === body.projectId);
    const role = project?.roles.find(r => r.id === body.roleId);
    const model = share.models.find(m => m.provider === body.provider && m.modelId === body.modelId);
    if (!project || !role || !model) throw new ShareError("项目、角色或模型未获授权", 403);
    if (this.list(guest).length >= 12 || this.sessions.size >= 100) throw new ShareError("窗口数量已达上限", 429);
    const registry = this.registryFactory();
    const selected = registry.find(model.provider, model.modelId);
    if (!selected) throw new ShareError("主人选择的模型已不可用", 409);
    const id = randomUUID();
    const cwd = path.join(getAgentDir(), "share-runtime", id);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const files = new SharedFiles(project.root, () => this.active(share.id).writable, () => { this.active(share.id); });
    const tool = (name: string, description: string, parameters: ReturnType<typeof Type.Object>, execute: (args: Record<string, unknown>) => string) => defineTool({
      name, label: name, description, parameters,
      execute: async (_id, args) => {
        try { return { content: [{ type: "text" as const, text: execute(args) }], details: {} }; }
        catch (error) { throw new Error(error instanceof ShareError ? error.message : "文件操作被拒绝：请检查权限、相对路径及文件大小"); }
      },
    });
    const tools = [
      tool("share_list", "列出分享项目内目录，path 为相对路径，根目录使用 .。隐藏文件及链接不可访问。", Type.Object({ path: Type.String() }), args => files.list(String(args.path))),
      tool("share_read", "读取分享项目内普通文本文件，path 必须是相对路径，最大 200KB。", Type.Object({ path: Type.String() }), args => files.read(String(args.path))),
      ...(share.writable ? [tool("share_write", "创建或覆盖已授权项目内的文本文件，不创建父目录。仅支持相对路径。", Type.Object({ path: Type.String(), content: Type.String() }), args => files.write(String(args.path), String(args.content)))] : []),
    ];
    const engine = this.engineFactory.create({ model: selected, cwd, sessionId: id, tools, activeToolNames: tools.map(t => t.name), maxToolRounds: 15,
      systemPrompt: `${role.prompt}\n\n你在 DeerHux 分享窗口中工作。项目：${project.name}。默认中文回复。所有文件路径使用项目相对路径。${share.writable ? "主人允许新增和修改普通文本文件。" : "主人仅允许读取，不得修改文件。"}没有终端、MCP、扩展或子代理。无法执行的操作请直接说明。`,
      getApiKey: provider => registry.getApiKeyForProvider(provider) });
    engine.setAutoCompactionEnabled(false);
    engine.setAutoRecoveryMode("off");
    const session: Session = { id, shareId: share.id, guestId: guest.id, projectId: project.id, roleId: role.id, model, engine, messages: [], running: false, name: "新窗口", turns: 0, runtimeDirectory: cwd };
    engine.subscribe(event => {
      if (event.type === "message_update" || event.type === "message_start") session.partial = normalizeToolCalls(event.message as AgentMessage);
      if (event.type === "message_end") {
        session.messages.push(normalizeToolCalls(event.message as AgentMessage));
        session.partial = undefined;
      }
      if (event.type === "tool_execution_end") {
        const result = event.result as { content: { type: "text"; text: string }[] };
        session.messages.push({ role: "toolResult", toolCallId: String(event.toolCallId), toolName: String(event.toolName), content: result.content, isError: Boolean(event.isError), timestamp: Date.now() });
      }
      if (event.type === "agent_end" && event.error) session.error = "本次回复未完成，请检查主人端模型配置后重试";
    });
    this.sessions.set(id, session);
    return { id };
  }

  snapshot(guest: Guest, id: string) {
    const s = this.session(guest, id);
    return { id: s.id, messages: s.messages, partial: s.partial, running: s.running, error: s.error };
  }

  async command(guest: Guest, id: string, raw: unknown) {
    const body = exactObject(raw, ["type", "message"]);
    const s = this.session(guest, id);
    if (body.type === "abort") { await s.engine.abort(); return { success: true }; }
    if (body.type !== "prompt" || typeof body.message !== "string" || !body.message.trim() || body.message.length > 20_000) throw new ShareError("仅支持发送消息或停止");
    if (s.running) throw new ShareError("请等待当前回复完成", 409);
    if (s.turns >= 100 || [...this.sessions.values()].filter(v => v.running).length >= 4) throw new ShareError("已达会话或并发上限，请稍后重试或新建窗口", 429);
    s.running = true; s.error = undefined; s.turns++;
    s.name = body.message.slice(0, 32);
    const message = body.message;
    s.messages.push({ role: "user", content: message, timestamp: Date.now() });
    // Set running synchronously before returning; never auto-replay a timed out POST.
    void s.engine.prompt(message).catch(() => { s.error = "模型请求失败，请检查主人端模型配置或新建窗口重试"; })
      .finally(() => { s.running = false; s.partial = undefined; });
    return { success: true };
  }

  async revoke(id: string) {
    const share = this.shares.get(id);
    if (!share) return;
    share.revoked = true;
    for (const [token, guest] of this.guests) if (guest.shareId === id) this.guests.delete(token);
    await Promise.all([...this.sessions.values()].filter(s => s.shareId === id).map(async s => {
      await s.engine.abort(); s.engine.dispose(); this.sessions.delete(s.id);
      rmSync(s.runtimeDirectory, { recursive: true, force: true });
    }));
    this.shares.delete(id); this.attempts.delete(id);
  }

  async expire() {
    for (const share of this.shares.values()) if (share.expiresAt !== null && share.expiresAt <= Date.now()) await this.revoke(share.id);
  }
}
