export interface SkillResource {
  name: string;
  content?: string;
}

/** 项目级指令和 Skill 资源查询边界。 */
export interface ProjectResourcePort {
  resolveSkill(cwd: string, name: string): Promise<SkillResource | undefined>;
}
