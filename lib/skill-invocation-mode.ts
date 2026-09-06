import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export class SkillInvocationModeError extends Error {}

/** Replace the invocation flag only inside frontmatter, repairing duplicate flags. */
export function setSkillInvocationMode(content: string, disabled: boolean): string {
  const key = "disable-model-invocation";
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const opening = content.match(/^---[ \t]*\r?\n/);
  let updated: string;
  if (!opening) {
    updated = `---${newline}${key}: ${disabled}${newline}---${newline}${content}`;
  } else {
    const rest = content.slice(opening[0].length);
    const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
    if (!closing) throw new SkillInvocationModeError("Skill 的 YAML 头部缺少结束标记 ---，请修复后重试。");
    const header = rest.slice(0, closing.index);
    // Delete all root-level occurrences, including explicit false and quoted keys.
    // Never edit similarly named text in the Markdown body or nested metadata.
    const cleaned = header.replace(/^(?:disable-model-invocation|"disable-model-invocation"|'disable-model-invocation')[ \t]*:[^\r\n]*(?:\r?\n|$)/gm, "");
    updated = `${opening[0]}${key}: ${disabled}${newline}${cleaned}${rest.slice(closing.index)}`;
  }
  try {
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(updated);
    if (frontmatter[key] !== disabled) throw new Error("invocation flag could not be updated");
  } catch {
    throw new SkillInvocationModeError("Skill 的 YAML 配置无效，无法保存调用方式；请检查头部字段格式。");
  }
  return updated;
}
