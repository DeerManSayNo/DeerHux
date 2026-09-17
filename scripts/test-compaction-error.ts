import assert from "node:assert/strict";
import { getCompactionClientError } from "../lib/compaction-error.ts";

assert.deepEqual(
  getCompactionClientError(new Error("压缩模型不存在: ddp/model-a")),
  {
    message: "压缩模型不存在: ddp/model-a",
    status: 400,
    errorCode: "COMPACTION_MODEL_NOT_FOUND",
  },
);

assert.deepEqual(
  getCompactionClientError(new Error("401 unauthorized")),
  {
    message: "压缩失败：当前 API Key 无效或认证失败，请检查模型配置中的 Key。",
    status: 502,
    errorCode: "AUTH_ERROR",
  },
);

assert.deepEqual(
  getCompactionClientError(new Error("压缩模型未返回有效摘要")),
  {
    message: "所选模型未返回有效摘要，请重试或切换压缩模型。",
    status: 502,
    errorCode: "COMPACTION_EMPTY_SUMMARY",
  },
);

assert.deepEqual(
  getCompactionClientError(new Error('404 Model "summary-model" is not supported')),
  {
    message: "所选压缩模型不可用，请检查模型名称、账号权限或切换其他模型。",
    status: 502,
    errorCode: "PERMISSION_DENIED",
  },
);

assert.deepEqual(
  getCompactionClientError(new Error("502 upstream bad gateway")),
  {
    message: "压缩失败：模型服务暂时异常，请稍后重试。",
    status: 502,
    errorCode: "SERVER_ERROR",
  },
);

assert.equal(getCompactionClientError(new Error("unexpected internal detail")), null);

console.log("compaction error tests passed");
