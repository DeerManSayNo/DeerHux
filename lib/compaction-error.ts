import { classifyLlmError } from "./llm-gateway/error-classifier.ts";

export type CompactionClientError = {
  message: string;
  status: number;
  errorCode?: string;
};

/** Convert expected compaction failures into safe, actionable API errors. */
export function getCompactionClientError(error: unknown): CompactionClientError | null {
  const message = error instanceof Error ? error.message : String(error);

  if (/^压缩模型不存在:/.test(message)) {
    return { message, status: 400, errorCode: "COMPACTION_MODEL_NOT_FOUND" };
  }
  if (/Conversation too short to compact/.test(message)) {
    return { message: "当前可归档的历史消息太少，暂时无法压缩。", status: 409, errorCode: "COMPACTION_TOO_SHORT" };
  }
  if (/当前会话尚未持久化|无法确定压缩边界|session 可能已损坏/.test(message)) {
    return { message: "当前会话状态无法安全压缩，请刷新会话后重试。", status: 409, errorCode: "COMPACTION_STATE_INVALID" };
  }
  if (/无法压缩.*prompt 正在运行|压缩已在进行中/.test(message)) {
    return { message: "当前会话仍在运行或压缩中，请等待完成后重试。", status: 409, errorCode: "COMPACTION_BUSY" };
  }
  if (/压缩模型未返回有效摘要/.test(message)) {
    return { message: "所选模型未返回有效摘要，请重试或切换压缩模型。", status: 502, errorCode: "COMPACTION_EMPTY_SUMMARY" };
  }
  if (/\b404\b|model.*(?:not found|not supported|not available)/i.test(message)) {
    return { message: "所选压缩模型不可用，请检查模型名称、账号权限或切换其他模型。", status: 502, errorCode: "PERMISSION_DENIED" };
  }

  const embeddedStatus = message.match(/(?:^|\s)([45]\d{2})(?:\s|:|$)/)?.[1];
  const normalized = classifyLlmError(
    embeddedStatus ? { message, status: Number(embeddedStatus) } : error,
  );
  if (normalized.code === "UNKNOWN") return null;
  return {
    message: `压缩失败：${normalized.userMessage}`,
    status: 502,
    errorCode: normalized.code,
  };
}
