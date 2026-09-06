// Installation recipes are application-owned; never execute commands from Skill text or requests.
export function cliInstallCommand(command: string, platform: string = process.platform): string | undefined {
  if (command === "webcmd") return "npm install -g @agentrhq/webcmd";
  if (command === "tvly" && (platform === "darwin" || platform === "linux")) {
    return "curl -fsSL https://cli.tavily.com/install.sh | bash";
  }
  return undefined;
}
