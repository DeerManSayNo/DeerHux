type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const IMAGE_BUDGET = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Preserve standard MCP image/error semantics; never stringify binary blocks. */
export function mapMcpToolResult(result: unknown, supportsImages = true) {
  let bytes = 0;
  const content: Content[] = [];
  const addText = (text: string) => { bytes += Buffer.byteLength(text); content.push({ type: "text", text }); };
  let imageBytes = 0;
  if (record(result) && Array.isArray(result.content)) {
    for (const item of result.content) {
      if (record(item) && item.type === "image") {
        const { data, mimeType } = item;
        if (!supportsImages) { addText("[MCP image omitted: model does not support images]"); continue; }
        if (typeof data !== "string" || typeof mimeType !== "string" || !IMAGE_TYPES.has(mimeType)
          || data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
          addText("[MCP image omitted: invalid image payload]"); continue;
        }
        imageBytes += Buffer.byteLength(data, "base64");
        if (imageBytes > IMAGE_BUDGET) { addText("[MCP image omitted: 4 MiB image budget exceeded]"); continue; }
        bytes += Buffer.byteLength(data);
        content.push({ type: "image", data, mimeType });
      } else if (record(item) && typeof item.text === "string") {
        addText(item.text);
      } else if (record(item) && (typeof item.data === "string" || item.type === "audio")) {
        addText(`[MCP ${String(item.type ?? "binary")} content omitted]`);
      } else {
        addText(JSON.stringify(item) ?? "");
      }
    }
  } else {
    addText(typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? "");
  }
  return { content, isError: record(result) && result.isError === true, bytes };
}
