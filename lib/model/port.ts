import type { Api, Model } from "@earendil-works/pi-ai";

export type RuntimeModel = Model<Api>;

/** DeerHux 运行时按稳定标识解析完整模型配置的能力边界。 */
export interface ModelCatalogPort {
  resolve(provider: string, modelId: string): RuntimeModel | undefined;
}
