import { accessSync, closeSync, constants, mkdirSync, openSync, readdirSync, unlinkSync } from "fs";
import path from "path";

export const MINIMUM_NODE_VERSION = "22.19.0";

export type RuntimeReadinessResult = {
  ready: true;
  nodeVersion: string;
  modelCount: number;
};

export class RuntimeReadinessError extends Error {
  readonly code:
    | "NODE_VERSION_UNSUPPORTED"
    | "AGENT_DIRECTORY_UNAVAILABLE"
    | "RUN_STORE_UNAVAILABLE"
    | "MODEL_RUNTIME_UNAVAILABLE";

  constructor(
    code:
      | "NODE_VERSION_UNSUPPORTED"
      | "AGENT_DIRECTORY_UNAVAILABLE"
      | "RUN_STORE_UNAVAILABLE"
      | "MODEL_RUNTIME_UNAVAILABLE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeReadinessError";
    this.code = code;
  }
}

function parseVersion(version: string): [number, number, number] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNodeVersionSupported(
  version: string,
  minimum = MINIMUM_NODE_VERSION,
): boolean {
  const current = parseVersion(version);
  const required = parseVersion(minimum);
  if (!current || !required) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index];
  }
  return true;
}

/**
 * Desktop startup calls this endpoint before exposing the application UI.
 * Keep heavy agent dependencies dynamic: an incompatible bundled Node binary
 * must produce a structured 503 instead of failing while the route is imported.
 */
export async function checkRuntimeReadiness(): Promise<RuntimeReadinessResult> {
  const nodeVersion = process.versions.node;
  if (!isNodeVersionSupported(nodeVersion)) {
    throw new RuntimeReadinessError(
      "NODE_VERSION_UNSUPPORTED",
      `内置 Node.js v${nodeVersion} 版本过低，需要 >=${MINIMUM_NODE_VERSION}`,
    );
  }

  let codingAgent: typeof import("@earendil-works/pi-coding-agent");
  try {
    codingAgent = await import("@earendil-works/pi-coding-agent");
    const piAi = await import("@earendil-works/pi-ai");
    if (typeof piAi.getSupportedThinkingLevels !== "function") {
      throw new Error("pi-ai export is unavailable");
    }
  } catch (error) {
    throw new RuntimeReadinessError(
      "MODEL_RUNTIME_UNAVAILABLE",
      `模型运行时无法加载（Node.js v${nodeVersion}）`,
      { cause: error },
    );
  }

  const agentDir = codingAgent.getAgentDir();
  try {
    mkdirSync(agentDir, { recursive: true });
    accessSync(agentDir, constants.R_OK | constants.W_OK);
  } catch (error) {
    throw new RuntimeReadinessError(
      "AGENT_DIRECTORY_UNAVAILABLE",
      "模型配置目录不可读写，请检查用户目录权限或安全软件拦截",
      { cause: error },
    );
  }

  try {
    const runsDir = path.join(agentDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    const probePath = path.join(runsDir, `.readiness-${process.pid}-${Date.now()}`);
    const descriptor = openSync(probePath, "wx", 0o600);
    closeSync(descriptor);
    unlinkSync(probePath);

    await import("./agent-runtime/run-store");
    readdirSync(runsDir);
  } catch (error) {
    throw new RuntimeReadinessError(
      "RUN_STORE_UNAVAILABLE",
      "运行状态目录无法初始化，请检查用户目录权限或安全软件拦截",
      { cause: error },
    );
  }

  try {
    const authStorage = codingAgent.AuthStorage.create();
    const registry = codingAgent.ModelRegistry.create(authStorage);
    return {
      ready: true,
      nodeVersion,
      modelCount: registry.getAvailable().length,
    };
  } catch (error) {
    throw new RuntimeReadinessError(
      "MODEL_RUNTIME_UNAVAILABLE",
      "模型注册表初始化失败，请检查模型配置文件或重新安装应用",
      { cause: error },
    );
  }
}

export function getReadinessErrorPayload(error: unknown): {
  ready: false;
  code: string;
  message: string;
  nodeVersion: string;
  requiredNodeVersion: string;
} {
  const known = error instanceof RuntimeReadinessError ? error : null;
  return {
    ready: false,
    code: known?.code ?? "RUNTIME_READINESS_FAILED",
    message: known?.message ?? "后台运行时自检失败",
    nodeVersion: process.versions.node,
    requiredNodeVersion: MINIMUM_NODE_VERSION,
  };
}
