import path from "node:path";

export const MANAGED_BUILTIN_SKILLS = [
  { name: "webcmd-browser", description: "通过 Webcmd 操作真实浏览器，适用于网页交互、登录交接、可视界面验证和临时页面检查。" },
  { name: "create-role", description: "创建、修改或删除 DeerHux 角色及其长期设定。" },
  { name: "create-skill", description: "创建或修改可复用的 DeerHux Skill，包括触发描述、操作指南和必要的辅助文件。" },
] as const;

export function builtinSkillPath(name: string): string {
  return path.join(process.cwd(), "lib", "builtin-skills", name, "SKILL.md");
}

export function builtinSkillPaths(): string[] {
  return MANAGED_BUILTIN_SKILLS.map(({ name }) => builtinSkillPath(name));
}

export function roleManagementSkillPath(): string {
  return builtinSkillPath("create-role");
}
