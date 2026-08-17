import { DeerLoopEngine, type DeerLoopOptions } from "./deer-loop";
import type { AgentEngineFactoryPort, AgentEnginePort } from "./port";

/**
 * DeerLoop 的具体实例化工厂。
 *
 * 默认运行时策略在这里安装，避免调用方创建出行为不一致的生产引擎。资源发现与
 * 会话编排暂时仍由上层 composition root 完成，并通过 DeerLoopOptions 显式注入。
 */
export class DeerLoopEngineFactory implements AgentEngineFactoryPort<DeerLoopOptions> {
  create(options: DeerLoopOptions): AgentEnginePort {
    const engine = new DeerLoopEngine(options);
    engine.installRetryHardening();
    return engine;
  }
}

/** 默认生产工厂。单例无可变状态，可安全复用。 */
export const deerLoopEngineFactory = new DeerLoopEngineFactory();
