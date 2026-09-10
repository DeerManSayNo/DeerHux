import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findEmptyModelId } from "../lib/models-config-validation.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "deerhux-models-validation-"));
process.env.DEERHUX_CODING_AGENT_DIR = root;
process.env.PI_CODING_AGENT_DIR = root;
const { PUT } = await import("../app/api/models-config/route.ts");
const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
const configPath = path.join(root, "models.json");
const preferencesPath = path.join(root, "model-preferences.json");
const valid = { providers: { fixture: {
  api: "openai-responses", baseUrl: "https://example.invalid/v1", apiKey: "fixture-key",
  models: [{ id: "fixture-model", fastMode: true }],
} } };
const put = (body: unknown) => PUT(new Request("http://localhost/api/models-config", {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));

try {
  assert.equal((await put(valid)).status, 200);
  const before = await fs.readFile(configPath, "utf8");
  const preferences = await fs.readFile(preferencesPath, "utf8");
  assert.equal(ModelRegistry.create(AuthStorage.inMemory(), configPath).getError(), undefined);

  const malformed = await PUT(new Request("http://localhost/api/models-config", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: "{",
  }));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, "模型配置 JSON 格式无效");
  assert.equal(await fs.readFile(configPath, "utf8"), before);
  assert.equal(await fs.readFile(preferencesPath, "utf8"), preferences);

  // Reproduce adding a draft, leaving its ID empty, then saving another edit.
  for (const id of ["", "   "]) {
    const draft = { providers: { fixture: { ...valid.providers.fixture, models: [{ id: "fixture-model" }, { id }] } } };
    assert.equal(findEmptyModelId(draft)?.index, 1);
    const response = await put(draft);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /fixture.*第 2 个模型/);
    assert.equal(await fs.readFile(configPath, "utf8"), before);
    assert.equal(await fs.readFile(preferencesPath, "utf8"), preferences);
  }

  // The runtime schema also rejects non-ID errors before replacing either file.
  for (const invalid of [
    { providers: { fixture: { ...valid.providers.fixture, models: [{ id: "bad", contextWindow: -1 }] } } },
    { providers: { fixture: { models: [{ id: "bad" }] } } },
    { providers: [] }, null,
  ]) {
    const response = await put(invalid);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, invalid === null ? /必须是 JSON 对象/ : /模型配置无效，未保存/);
    assert.equal(await fs.readFile(configPath, "utf8"), before);
    assert.equal(await fs.readFile(preferencesPath, "utf8"), preferences);
  }
  assert.deepEqual((await fs.readdir(root)).sort(), ["model-preferences.json", "models.json"]);
  const repaired = structuredClone(valid);
  repaired.providers.fixture.models.push({ id: "second-model", fastMode: false });
  assert.equal((await put(repaired)).status, 200);
  assert.ok(ModelRegistry.create(AuthStorage.inMemory(), configPath).find("fixture", "second-model"));
  console.log("models-config validation passed: empty drafts, whitespace IDs, runtime schema, preservation, cleanup, corrected save");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
