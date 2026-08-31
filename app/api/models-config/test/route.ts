import { NextResponse } from "next/server";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { AuthStorage, createAgentSession, getAgentDir, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

const TEST_TIMEOUT_MS = 20_000;

function generateSolidColorPng(color: readonly [number, number, number]): string {
  const [r, g, b] = color;
  // Build a minimal 2x2 RGB PNG
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let j = 0; j < 8; j++) {
        c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
      }
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type, "ascii");
    const crcInput = Buffer.concat([typeB, data]);
    const crcVal = Buffer.alloc(4);
    crcVal.writeUInt32BE(crc32(crcInput));
    return Buffer.concat([len, typeB, data, crcVal]);
  }

  // IHDR: 2x2, 8-bit RGB
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);  // width
  ihdr.writeUInt32BE(2, 4);  // height
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type (RGB)
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // IDAT: raw pixel data (2 rows of 2 pixels, each row prefixed with filter=0)
  const rawData: number[] = [];
  for (let row = 0; row < 2; row++) {
    rawData.push(0); // filter: none
    for (let col = 0; col < 2; col++) {
      rawData.push(r, g, b);
    }
  }
  // Simple deflate: store (no compression) with zlib header
  const zlibHeader = Buffer.from([0x78, 0x01]); // CMF=0x78, FLG=0x01 (no compression, default)
  const deflateData: number[] = [];
  let offset = 0;
  while (offset < rawData.length) {
    const blockSize = Math.min(rawData.length - offset, 0xffff);
    const isFinal = offset + blockSize >= rawData.length;
    // BFINAL + BTYPE=00, followed by LEN/NLEN for an uncompressed deflate block.
    deflateData.push(isFinal ? 1 : 0);
    deflateData.push(blockSize & 0xff, (blockSize >> 8) & 0xff);
    deflateData.push((~blockSize) & 0xff, ((~blockSize) >> 8) & 0xff);
    for (let i = offset; i < offset + blockSize; i++) {
      deflateData.push(rawData[i]);
    }
    offset += blockSize;
  }

  const adler = (() => {
    let s1 = 1, s2 = 0;
    for (const byte of rawData) {
      s1 = (s1 + byte) % 65521;
      s2 = (s2 + s1) % 65521;
    }
    return (s2 << 16) | s1;
  })();
  const compressedData = Buffer.concat([
    zlibHeader,
    Buffer.from(deflateData),
    Buffer.from([(adler >> 24) & 0xff, (adler >> 16) & 0xff, (adler >> 8) & 0xff, adler & 0xff]),
  ]);

  const png = Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressedData),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  return png.toString("base64");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return isRecord(message)
    && message.role === "assistant"
    && Array.isArray(message.content);
}

function latestAssistantMessage(messages: unknown[]): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isAssistantMessage(message)) return message;
  }
  return null;
}

async function runWithTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<{ value?: T; timedOut: boolean }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.then((value) => ({ value, timedOut: false })),
      new Promise<{ timedOut: true }>((resolve) => {
        timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function POST(req: Request) {
  let tempDir: string | undefined;

  try {
    const body = await req.json() as { providerName?: unknown; provider?: unknown; model?: unknown; testMode?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ ok: false, error: "providerName is required" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ ok: false, error: "provider is required" }, { status: 400 });
    if (!isRecord(body.model)) return NextResponse.json({ ok: false, error: "model is required" }, { status: 400 });

    const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
    if (!modelId) return NextResponse.json({ ok: false, error: "Model ID is required" }, { status: 400 });

    tempDir = mkdtempSync(join(tmpdir(), "deerhux-model-test-"));
    const modelsPath = join(tempDir, "models.json");
    const { fastMode: _fastMode, ...testModel } = body.model;
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        [providerName]: {
          ...body.provider,
          models: [{ ...testModel, id: modelId }],
        },
      },
    }, null, 2), "utf8");

    const registry = ModelRegistry.create(AuthStorage.create(), modelsPath);
    const loadError = registry.getError();
    if (loadError) return NextResponse.json({ ok: false, error: loadError });

    const model = registry.find(providerName, modelId);
    if (!model) return NextResponse.json({ ok: false, error: `Model not found: ${providerName}/${modelId}` });

    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error });
    if (!auth.apiKey) return NextResponse.json({ ok: false, error: `No API key found for "${providerName}"` });

    const startedAt = Date.now();
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

    try {
      const testMode = typeof body.testMode === "string" ? body.testMode : "text";
      const isImageTest = testMode === "image";

      const colorName = isImageTest ? ["red", "blue", "green"][Math.floor(Math.random() * 3)] : "red";
      const colors: Record<string, readonly [number, number, number]> = {
        red: [220, 50, 50],
        blue: [50, 100, 220],
        green: [50, 180, 80],
      };
      const pngBase64 = generateSolidColorPng(colors[colorName]);

      const result = await createAgentSession({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        model,
        modelRegistry: registry,
        sessionManager: SessionManager.inMemory(process.cwd()),
        tools: [],
      });
      session = result.session;

      const prompt = isImageTest
        ? "What color is this image? Reply with just the color name in English (one word)."
        : "Reply with OK only.";
      const images: ImageContent[] | undefined = isImageTest
        ? [{ type: "image", data: pngBase64, mimeType: "image/png" }]
        : undefined;

      const run = await runWithTimeout(
        session.prompt(prompt, {
          images,
          expandPromptTemplates: false,
          source: "interactive",
        }),
        TEST_TIMEOUT_MS
      );
      const latencyMs = Date.now() - startedAt;

      if (run.timedOut) {
        await session.abort().catch(() => {});
        return NextResponse.json({
          ok: false,
          error: "Test timed out",
          latencyMs,
          testMode,
        });
      }

      const message = latestAssistantMessage(session.messages);
      if (!message) {
        return NextResponse.json({
          ok: false,
          error: "Model returned no assistant message",
          latencyMs,
          testMode,
        });
      }

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return NextResponse.json({
          ok: false,
          error: message.errorMessage ?? "Model returned an error",
          latencyMs,
          testMode,
        });
      }

      return NextResponse.json({
        ok: true,
        latencyMs,
        responseText: getAssistantText(message).slice(0, 300),
        testMode,
      });
    } finally {
      if (session?.isStreaming) await session.abort().catch(() => {});
      session?.dispose();
    }
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
