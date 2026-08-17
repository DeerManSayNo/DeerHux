export type McpWireFraming = "line" | "cl";
export type McpStdioFramingMode = "auto" | "newline" | "content-length";

export function selectFramingAttempts(
  mode: McpStdioFramingMode,
  cached?: McpWireFraming,
): McpWireFraming[] {
  if (mode === "newline") return ["line"];
  if (mode === "content-length") return ["cl"];
  return cached
    ? [cached, cached === "line" ? "cl" : "line"]
    : ["line", "cl"];
}

export function encodeMcpMessage(message: unknown, framing: McpWireFraming): string {
  const json = JSON.stringify(message);
  return framing === "line"
    ? `${json}\n`
    : `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

export function detectMcpResponseFraming(buffer: string): McpWireFraming | null {
  const normalized = buffer.toLowerCase();
  const header = "content-length:";
  if (header.startsWith(normalized)) return null;
  return normalized.startsWith(header) ? "cl" : "line";
}
