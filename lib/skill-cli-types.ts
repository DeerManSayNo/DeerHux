export interface SkillCliDependency {
  command: string;
  installUrl?: string;
  installCommand?: string;
  status: "available" | "missing" | "unsupported";
}
