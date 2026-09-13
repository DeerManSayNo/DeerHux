"use client";

import { useContext, useState } from "react";
import { resolveLocalFileHref } from "@/lib/external-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { AiLinkWorkspace } from "./AiOutputLink";

/** Read agent-generated local images through the existing permission-checked API. */
export function AiOutputImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const cwd = useContext(AiLinkWorkspace);
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const localPath = src && !src.startsWith("/api/") ? resolveLocalFileHref(src, cwd) : null;
  const localUrl = localPath ? `/api/files/${encodeFilePathForApi(localPath)}?type=read` : undefined;
  // Root-relative web assets (e.g. /brand/logo.png) share filesystem syntax.
  // If no readable local file exists, allow the original web asset URL.
  const webFallback = src?.startsWith("/") && !src.startsWith("//") ? src : undefined;
  const imageSrc = localUrl && !failedSources.includes(localUrl) ? localUrl : localUrl ? webFallback : src;

  if (!imageSrc || failedSources.includes(imageSrc)) {
    return <span role="img" aria-label={alt || "图片加载失败"} title={src} style={{ color: "var(--text-muted)" }}>
      {alt ? `图片加载失败：${alt}` : "图片加载失败"}
    </span>;
  }

  // eslint-disable-next-line @next/next/no-img-element -- local files use the permission-checked file API.
  return <img src={imageSrc} alt={alt ?? ""} title={title} onError={() => setFailedSources((failed) => [...failed, imageSrc])} />;
}
