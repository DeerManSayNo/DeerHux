import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ProjectResourcePort, SkillResource } from "./port";

export class PiProjectResourceAdapter implements ProjectResourcePort {
  async resolveSkill(cwd: string, name: string): Promise<SkillResource | undefined> {
    try {
      const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
      await loader.reload();
      const skill = loader.getSkills().skills.find((item) => item.name === name);
      if (skill?.filePath && existsSync(skill.filePath)) {
        return { name, content: readFileSync(skill.filePath, "utf8") };
      }
    } catch {
      // 回退到 DeerHux 内置 Skill。
    }
    const builtinPath = path.join(process.cwd(), "lib", "builtin-skills", name, "SKILL.md");
    if (existsSync(builtinPath)) return { name, content: readFileSync(builtinPath, "utf8") };
    return undefined;
  }
}
