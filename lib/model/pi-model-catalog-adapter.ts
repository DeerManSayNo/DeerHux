import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelCatalogPort, RuntimeModel } from "./port";

interface PiModelRegistryLike {
  find(provider: string, modelId: string): RuntimeModel | undefined;
}

/**
 * 优先复用当前 Session 的 Registry；配置热更新后未命中时，重建 Registry 再查一次。
 */
export class PiModelCatalogAdapter implements ModelCatalogPort {
  private readonly registry: PiModelRegistryLike;
  private readonly refreshRegistry: () => PiModelRegistryLike;

  constructor(
    registry: PiModelRegistryLike,
    refreshRegistry: () => PiModelRegistryLike = () => ModelRegistry.create(AuthStorage.create()),
  ) {
    this.registry = registry;
    this.refreshRegistry = refreshRegistry;
  }

  resolve(provider: string, modelId: string): RuntimeModel | undefined {
    return this.registry.find(provider, modelId)
      ?? this.refreshRegistry().find(provider, modelId);
  }
}
