import assert from "node:assert/strict";
import { parseProviderConfigJson, serializeProviderConfig } from "../lib/models-config-transfer.ts";

const provider = {
  api: "openai-responses",
  baseUrl: "https://example.invalid/v1",
  apiKey: "secret-key",
  models: [{ id: "model-a", contextWindow: 128000 }],
};

const text = serializeProviderConfig("fixture", provider);
assert.deepEqual(parseProviderConfigJson(text), { fixture: provider });
assert.match(text, /secret-key/);
assert.throws(() => parseProviderConfigJson("{"), /JSON 格式无效/);
assert.throws(() => parseProviderConfigJson("{}"), /providers/);
assert.throws(() => parseProviderConfigJson('{"providers":{}}'), /没有可导入/);
assert.throws(
  () => parseProviderConfigJson('{"providers":{"fixture":{"models":[{"id":""}]}}}'),
  /缺少有效的 id/,
);

console.log("models-config transfer passed: round trip, API key, malformed input, empty providers, model IDs");
