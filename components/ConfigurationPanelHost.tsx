"use client";

import dynamic from "next/dynamic";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";

type ConfigurationPanel = "models" | "skills" | "extensions" | "scheduler" | "role" | "memory" | "mcp" | "wechat";

interface ProjectOption {
  cwd: string;
  displayName: string;
}

export interface ConfigurationPanelHostHandle {
  open: (panel: ConfigurationPanel) => void;
}

interface ConfigurationPanelHostProps {
  cwd?: string;
  projects: ProjectOption[];
  roleProjects: ProjectOption[];
  onModelsChanged: () => void;
}

const ModelsConfig = dynamic(() => import("./ModelsConfig").then((module) => module.ModelsConfig), { loading: () => null });
const SkillsConfig = dynamic(() => import("./SkillsConfig").then((module) => module.SkillsConfig), { loading: () => null });
const SchedulerPanel = dynamic(() => import("./SchedulerPanel").then((module) => module.SchedulerPanel), { loading: () => null });
const RoleConfig = dynamic(() => import("./RoleConfig").then((module) => module.RoleConfig), { loading: () => null });
const MemoryConfig = dynamic(() => import("./MemoryConfig").then((module) => module.MemoryConfig), { loading: () => null });
const McpConfig = dynamic(() => import("./McpConfig").then((module) => module.McpConfig), { loading: () => null });
const ExtensionsConfig = dynamic(() => import("./ExtensionsConfig").then((module) => module.ExtensionsConfig), { loading: () => null });
const WeChatConfig = dynamic(() => import("./WeChatConfig").then((module) => module.WeChatConfig), { loading: () => null });

function preloadConfigurationPanels() {
  void Promise.allSettled([
    import("./ModelsConfig").then((module) => module.preloadModelsConfigData()),
    import("./SkillsConfig"),
    import("./SchedulerPanel"),
    import("./RoleConfig"),
    import("./MemoryConfig"),
    import("./McpConfig"),
    import("./ExtensionsConfig"),
    import("./WeChatConfig"),
  ]);
}

export const ConfigurationPanelHost = forwardRef<ConfigurationPanelHostHandle, ConfigurationPanelHostProps>(
  function ConfigurationPanelHost({ cwd, projects, roleProjects, onModelsChanged }, ref) {
    const [openPanel, setOpenPanel] = useState<ConfigurationPanel | null>(null);

    useImperativeHandle(ref, () => ({ open: setOpenPanel }), []);

    useEffect(() => {
      const timer = window.setTimeout(preloadConfigurationPanels, 0);
      return () => window.clearTimeout(timer);
    }, []);

    return (
      <>
        {openPanel === "models" && <ModelsConfig onClose={() => setOpenPanel(null)} onSaved={onModelsChanged} />}
        {openPanel === "skills" && <SkillsConfig projects={projects} onClose={() => setOpenPanel(null)} />}
        {openPanel === "extensions" && cwd && <ExtensionsConfig cwd={cwd} onClose={() => setOpenPanel(null)} />}
        {openPanel === "scheduler" && <SchedulerPanel onClose={() => setOpenPanel(null)} cwd={cwd} />}
        {openPanel === "role" && <RoleConfig onClose={() => setOpenPanel(null)} cwd={cwd} projects={roleProjects} />}
        {openPanel === "memory" && <MemoryConfig onClose={() => setOpenPanel(null)} cwd={cwd} />}
        {openPanel === "mcp" && <McpConfig onClose={() => setOpenPanel(null)} cwd={cwd} />}
        {openPanel === "wechat" && <WeChatConfig onClose={() => setOpenPanel(null)} />}
      </>
    );
  },
);
