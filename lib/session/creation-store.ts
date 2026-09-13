import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export class SessionCreationError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export interface CreationRecord {
  version: 1;
  cwd: string;
  requestId: string;
  sessionId: string;
  sessionFile: string;
  header?: object;
  initialized: boolean;
}

function atomicWrite(file: string, data: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(data) + "\n", { mode: 0o600, flush: true });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Inspect compact JSONL metadata with bounded memory, including image-heavy entries.
 * Only the entry prefix and tail are retained; display receipts put IDs after content.
 * A matching request in an unrecognised/oversized metadata layout fails closed.
 */
export async function findPromptReceipt(file: string, requestId: string, signal?: AbortSignal): Promise<{ turnId?: string } | null> {
  let prefix = "", tail = "", overlap = "", matched = false, length = 0;
  const needle = JSON.stringify(requestId);
  const finish = () => {
    if (!length) return null;
    if (length <= 64 * 1024) {
      let entry;
      try { entry = JSON.parse(tail); } catch { throw new SessionCreationError("历史会话包含损坏的记录，无法确认请求是否已执行"); }
      if (entry.type !== "custom" || entry.customType !== "display_user_message" || entry.data?.clientMessageId !== requestId) return null;
      return { turnId: typeof entry.data.turnId === "string" ? entry.data.turnId : undefined };
    }
    if (!matched) return null;
    if (!/^\{"type":"custom",/.test(prefix) || !prefix.includes('"customType":"display_user_message"')) {
      return null;
    }
    const id = /"clientMessageId"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(tail)?.[1];
    if (id !== requestId) throw new SessionCreationError("历史请求标识无法可靠读取，请检查目标会话后重试");
    const turnId = /"turnId"\s*:\s*"([A-Za-z0-9_:-]+)"/.exec(tail)?.[1];
    return { turnId };
  };
  for await (const chunk of createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024, signal })) {
    for (const [index, part] of (chunk as string).split("\n").entries()) {
      if (index > 0) {
        const receipt = finish();
        if (receipt) return receipt;
        prefix = ""; tail = ""; overlap = ""; matched = false; length = 0;
      }
      length += part.length;
      prefix = (prefix + part).slice(0, 4096);
      matched ||= (overlap + part).includes(needle);
      overlap = part.slice(-needle.length);
      tail = (tail + part).slice(-64 * 1024);
    }
  }
  return finish();
}

export class SessionCreationStore {
  constructor(private readonly directory: string) {}

  private file(cwd: string, requestId: string) {
    const key = createHash("sha256").update(resolve(cwd) + "\0" + requestId).digest("hex");
    try { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); }
    catch { throw new SessionCreationError("无法保存会话创建记录，请检查磁盘空间和目录权限", 507); }
    return join(this.directory, `${key}.json`);
  }

  /** File lock spans lookup, startup and prompt admission, including other app processes.
   * A live owner is never evicted on an elapsed timeout. Dead owners are reclaimable.
   */
  async withRequest<T>(cwd: string, requestId: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const lock = this.file(cwd, requestId) + ".lock";
    const owner = `${process.pid}:${randomUUID()}`;
    for (;;) {
      signal.throwIfAborted();
      try {
        // Publish a fully written owner atomically: a crash cannot leave an empty
        // exclusive lock whose owning process would be impossible to identify.
        const candidate = `${lock}.${owner.replace(":", "-")}.candidate`;
        try {
          writeFileSync(candidate, owner, { mode: 0o600, flush: true });
          linkSync(candidate, lock);
        } finally {
          if (existsSync(candidate)) unlinkSync(candidate);
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new SessionCreationError("无法保存会话创建锁，请检查磁盘空间和目录权限", 507);
        let value: string;
        try { value = readFileSync(lock, "utf8"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const pid = Number(value.split(":")[0]);
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") {
              // One reclaimer per owner token, across processes. Keep the tiny
              // tombstone so a delayed reclaimer cannot delete a new owner's lock.
              const tombstone = lock + ".reaped-" + createHash("sha256").update(value).digest("hex");
              try {
                mkdirSync(tombstone);
                if (existsSync(lock) && readFileSync(lock, "utf8") === value) unlinkSync(lock);
              } catch (reapError) {
                if (!["EEXIST", "ENOENT"].includes((reapError as NodeJS.ErrnoException).code ?? "")) throw reapError;
                await new Promise<void>((done) => setTimeout(done, 50));
              }
              continue;
            }
          }
        }
        await new Promise<void>((done) => setTimeout(done, 50));
      }
    }
    try { return await work(); } finally {
      if (existsSync(lock) && readFileSync(lock, "utf8") === owner) unlinkSync(lock);
    }
  }

  async prepare(cwd: string, requestId: string, allocate: () => { sessionId: string; sessionFile: string; header: object }, legacyLookup: () => Promise<{ sessionId: string; sessionFile: string } | undefined>): Promise<CreationRecord> {
    const file = this.file(cwd, requestId);
    let record: CreationRecord;
    if (existsSync(file)) {
      try { record = JSON.parse(readFileSync(file, "utf8")); } catch { throw new SessionCreationError("会话创建记录损坏，已停止重试以避免重复执行"); }
      if (record.version !== 1 || record.cwd !== resolve(cwd) || record.requestId !== requestId || !record.sessionId || !record.sessionFile || typeof record.initialized !== "boolean") {
        throw new SessionCreationError("会话创建记录不匹配，已停止重试以避免重复执行");
      }
    } else {
      // v2 IDs are emitted only by the new client. Old pending requests retain
      // their original IDs and receive a one-time streaming compatibility lookup.
      const legacy = requestId.startsWith("v2_") ? undefined : await legacyLookup();
      record = { version: 1, cwd: resolve(cwd), requestId, ...(legacy ?? allocate()), initialized: !!legacy };
      try { atomicWrite(file, record); } catch { throw new SessionCreationError("会话创建状态保存失败，请检查磁盘空间和目录权限", 507); }
    }
    if (!record.initialized) {
      try {
        if (!record.header) throw new Error("Missing reserved header");
        // Reserve is durable before creating the JSONL. Interrupted initialization
        // resumes at exactly the same ID/path; no engine or prompt has run yet.
        atomicWrite(record.sessionFile, record.header);
        record.initialized = true;
        atomicWrite(file, record);
      } catch { throw new SessionCreationError("会话文件初始化失败，可安全重试；请检查磁盘空间和目录权限", 507); }
    }
    if (!existsSync(record.sessionFile)) throw new SessionCreationError("此前创建的会话文件已丢失，已停止重试以避免重复执行");
    // Verify identity from a bounded header read before trusting any receipt or
    // allowing SessionManager.open to repair an invalid file with a fresh ID.
    const fd = openSync(record.sessionFile, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
      const header = JSON.parse(text.split("\n", 1)[0]);
      if (header.type !== "session" || header.id !== record.sessionId || resolve(header.cwd) !== record.cwd) throw new Error("Identity mismatch");
    } catch { throw new SessionCreationError("此前创建的会话头损坏或项目不匹配，已停止重试以避免重复执行"); }
    finally { closeSync(fd); }
    return record;
  }
}
