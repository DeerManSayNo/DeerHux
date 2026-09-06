export interface SystemCli {
  path: string;
  name: string;
  realPath: string;
  source: "npm";
  packageName: string;
  version?: string;
  commands: string[];
  bundledClis?: Array<{ packageName: string; version?: string; commands: string[] }>;
  removable: boolean;
  reason?: string;
}
