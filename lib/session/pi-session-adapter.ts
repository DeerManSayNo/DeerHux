import { writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "../engine/loop-event";
import type {
  AgentSessionPort,
  SessionContextSnapshot,
  SessionCustomEntrySnapshot,
  SessionForkResult,
} from "./port";
import { SessionPersistenceError } from "./errors.ts";

/** 将 pi SessionManager 限制在 DeerHux 所需的公开能力集合内。 */
export class PiSessionAdapter implements AgentSessionPort {
  private readonly manager: SessionManager;

  constructor(manager: SessionManager) {
    this.manager = manager;
  }

  get id(): string {
    return this.manager.getSessionId();
  }

  get file(): string | undefined {
    return this.manager.getSessionFile();
  }

  get cwd(): string {
    return this.manager.getCwd();
  }

  get persisted(): boolean {
    return this.manager.isPersisted();
  }

  get leafId(): string | undefined {
    return this.manager.getLeafId() ?? undefined;
  }

  getCustomEntries(customType: string): SessionCustomEntrySnapshot[] {
    const result: SessionCustomEntrySnapshot[] = [];
    for (const entry of this.manager.getEntries()) {
      if (entry.type === "custom" && entry.customType === customType) {
        result.push({ id: entry.id, data: entry.data });
      }
    }
    return result;
  }

  appendModelChange(provider: string, modelId: string): string | undefined {
    if (!this.persisted) return undefined;
    return this.persist("append_model_change", () => this.manager.appendModelChange(provider, modelId));
  }

  appendThinkingLevelChange(level: string): string | undefined {
    if (!this.persisted) return undefined;
    return this.persist("append_thinking_level_change", () => this.manager.appendThinkingLevelChange(level));
  }

  appendCustomEntry(customType: string, data?: unknown): string | undefined {
    if (!this.persisted) return undefined;
    return this.persist(`append_custom_entry:${customType}`, () => this.manager.appendCustomEntry(customType, data));
  }

  navigate(targetId: string | null): SessionContextSnapshot {
    let branchId = targetId;
    let editorText: string | undefined;
    if (targetId) {
      const entry = this.manager.getEntry(targetId);
      if (!entry) throw new Error(`Session entry not found: ${targetId}`);
      if (targetId === this.manager.getLeafId()) {
        return this.snapshot();
      }
      if (entry.type === "message" && entry.message.role === "user") {
        branchId = entry.parentId;
        editorText = this.extractUserText(entry.message.content);
      } else if (entry.type === "custom_message") {
        branchId = entry.parentId;
        editorText = this.extractUserText(entry.content);
      }
    }
    if (branchId) this.manager.branch(branchId);
    else this.manager.resetLeaf();

    return this.snapshot(editorText);
  }

  fork(entryId: string): SessionForkResult | undefined {
    if (!this.persisted || !this.file) return undefined;
    const entry = this.manager.getEntry(entryId);
    if (!entry) throw new Error(`Session entry not found: ${entryId}`);

    const sessionDir = this.manager.getSessionDir();
    let sessionFile: string;
    if (!entry.parentId) {
      const forked = SessionManager.create(this.cwd, sessionDir);
      forked.newSession({ parentSession: this.file });
      const createdFile = forked.getSessionFile();
      const header = forked.getHeader();
      if (!createdFile || !header) throw new Error("Failed to create forked session");
      // pi 的 header-only Session 会延迟到首次 Entry 才写盘；Fork 必须立即可打开。
      writeFileSync(createdFile, `${JSON.stringify(header)}\n`, "utf8");
      sessionFile = createdFile;
    } else {
      const source = SessionManager.open(this.file, sessionDir);
      const branchedFile = source.createBranchedSession(entry.parentId);
      const header = source.getHeader();
      if (!branchedFile || !header) throw new Error("Failed to create forked session");
      // 仅含 user/model 等 Entry 时 pi 也会延迟落盘；Fork 返回前必须成为完整文件。
      const entries = [header, ...source.getEntries()];
      writeFileSync(branchedFile, `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
      sessionFile = branchedFile;
    }
    const sessionId = SessionManager.open(sessionFile, sessionDir).getSessionId();
    return { sessionId, sessionFile };
  }

  private persist<T>(operation: string, write: () => T): T {
    try {
      return write();
    } catch (error) {
      throw new SessionPersistenceError(operation, this.id, error);
    }
  }

  private snapshot(editorText?: string): SessionContextSnapshot {
    const context = this.manager.buildSessionContext();
    return {
      messages: [...context.messages] as AgentMessage[],
      model: context.model
        ? { provider: context.model.provider, modelId: context.model.modelId }
        : undefined,
      thinkingLevel: context.thinkingLevel,
      editorText,
    };
  }

  private extractUserText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((block): block is { type: "text"; text: string } => (
        typeof block === "object" && block !== null
        && "type" in block && block.type === "text"
        && "text" in block && typeof block.text === "string"
      ))
      .map((block) => block.text)
      .join("\n");
  }
}
