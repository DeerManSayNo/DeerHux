import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { AuthStorage, ModelRegistry, getAgentDir } from "@earendil-works/pi-coding-agent";
import { findEmptyModelId } from "@/lib/models-config-validation";
import { extractFastModePreferences, mergeFastModePreferences, writeFastModePreferences } from "@/lib/model-fast-mode";

export const dynamic = "force-dynamic";

function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

function readModelsJson(): Record<string, unknown> {
  const path = getModelsPath();
  if (!existsSync(path)) return { providers: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { providers: {} };
  }
}

const IS_POSIX = process.platform !== "win32";

class ModelsConfigValidationError extends Error {}

function tryChmod(filePath: string, mode: number): void {
  if (!IS_POSIX) return;
  try { chmodSync(filePath, mode); } catch { /* best effort */ }
}

function writeModelsJson(data: Record<string, unknown>): void {
  const path = getModelsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Atomic write: temp file + rename to avoid truncated config on interrupt
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    // Validate the candidate with the same loader used by sessions, before
    // replacing the live file. In-memory auth avoids reading credentials.
    const error = ModelRegistry.create(AuthStorage.inMemory(), tmpPath).getError();
    if (error) {
      throw new ModelsConfigValidationError(`模型配置无效，未保存：${error.replaceAll(tmpPath, "models.json")}`);
    }
    renameSync(tmpPath, path);
    tryChmod(path, 0o600);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* best effort cleanup */ }
    throw e;
  }
}

export async function GET() {
  return NextResponse.json(mergeFastModePreferences(readModelsJson()));
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "模型配置必须是 JSON 对象" }, { status: 400 });
    }
    const invalidModel = findEmptyModelId(body);
    if (invalidModel) return NextResponse.json({ error: invalidModel.message }, { status: 400 });
    const { config, preferences } = extractFastModePreferences(body);
    writeModelsJson(config);
    writeFastModePreferences(preferences);
    // Model registry refreshes on each /api/models request (no local cache to invalidate)
    return NextResponse.json({ success: true });
  } catch (_error) {
    if (_error instanceof ModelsConfigValidationError) {
      return NextResponse.json({ error: _error.message }, { status: 400 });
    }
    if (_error instanceof SyntaxError) {
      return NextResponse.json({ error: "模型配置 JSON 格式无效" }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
