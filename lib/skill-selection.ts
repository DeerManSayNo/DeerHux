import type { SkillReference } from "./types";

export function normalizeSkillNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((name): name is string => typeof name === "string")
    .map((name) => name.trim()).filter(Boolean))];
}

export function skillNames(skill?: { name?: unknown; names?: unknown } | null): string[] {
  return normalizeSkillNames([skill?.name, ...(Array.isArray(skill?.names) ? skill.names : [])]);
}

export function skillReference(value: unknown): SkillReference | undefined {
  const names = normalizeSkillNames(value);
  return names.length ? { name: names[0], ...(names.length > 1 ? { names } : {}) } : undefined;
}

/** A slash token at the caret opens the picker after prose boundaries; paths and /skill: text stay literal. */
export function skillQueryAtCaret(value: string, caret: number) {
  const match = /(?:^|[^A-Za-z0-9_./:\\~-])\/([^\s/]*)$/.exec(value.slice(0, caret));
  if (!match || match[1].startsWith("skill:")) return null;
  return { start: caret - match[1].length - 1, end: caret, query: match[1] };
}
