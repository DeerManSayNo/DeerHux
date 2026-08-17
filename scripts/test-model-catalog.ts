import assert from "node:assert/strict";
import { PiModelCatalogAdapter } from "../lib/model/pi-model-catalog-adapter.ts";
import type { RuntimeModel } from "../lib/model/port.ts";

const currentModel = { provider: "current", id: "model" } as RuntimeModel;
const refreshedModel = { provider: "fresh", id: "model" } as RuntimeModel;
let refreshCount = 0;
const catalog = new PiModelCatalogAdapter(
  {
    find: (provider, modelId) => (
      provider === currentModel.provider && modelId === currentModel.id ? currentModel : undefined
    ),
  },
  () => {
    refreshCount += 1;
    return {
      find: (provider, modelId) => (
        provider === refreshedModel.provider && modelId === refreshedModel.id
          ? refreshedModel
          : undefined
      ),
    };
  },
);

assert.equal(catalog.resolve("current", "model"), currentModel);
assert.equal(refreshCount, 0);
assert.equal(catalog.resolve("fresh", "model"), refreshedModel);
assert.equal(refreshCount, 1);
assert.equal(catalog.resolve("missing", "model"), undefined);
assert.equal(refreshCount, 2);
console.log("model catalog tests passed");
