"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { defaultUrlTransform } from "react-markdown";
import { normalizeExternalHref, resolveLocalFileHref } from "@/lib/external-links";

export const AiLinkWorkspace = createContext<string | null>(null);

// Preserve file links that react-markdown's web-only default would erase.
// Images also need file:// and Windows paths preserved for AiOutputImage.
export function aiOutputUrlTransform(url: string, key: string): string {
  if (key === "src" && !/[\u0000-\u001f\u007f]/.test(url) && resolveLocalFileHref(url)) return url;
  if (key !== "href") return defaultUrlTransform(url);
  if (/[\u0000-\u001f\u007f]/.test(url) || /%(?![a-f\d]{2})/i.test(url)) return "";
  if (normalizeExternalHref(url) || resolveLocalFileHref(url, "/workspace")) return url;
  return "";
}

const pending = new Map<string, Array<(valid: boolean) => void>>();
let scheduled = false;
function validateFile(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    pending.set(filePath, [...(pending.get(filePath) ?? []), resolve]);
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      const entries = [...pending];
      pending.clear();
      for (let i = 0; i < entries.length; i += 64) {
        const batch = entries.slice(i, i + 64);
        void fetch("/api/files/validate-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: batch.map(([path]) => path) }),
          signal: AbortSignal.timeout(5000),
        }).then(async (response) => {
          if (!response.ok) throw new Error("File validation failed");
          const body = await response.json() as { valid?: unknown };
          const valid = body.valid;
          batch.forEach(([, callbacks], index) => callbacks.forEach((done) => done(Array.isArray(valid) && valid[index] === true)));
        }).catch(() => batch.forEach(([, callbacks]) => callbacks.forEach((done) => done(false))));
      }
    }, 0);
  });
}

export function AiOutputLink({ href, children, title }: { href?: string; children?: ReactNode; title?: string }) {
  const cwd = useContext(AiLinkWorkspace);
  const external = href ? normalizeExternalHref(href) : null;
  const filePath = href && !external ? resolveLocalFileHref(href.replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, ""), cwd) : null;
  const [checkedPath, setCheckedPath] = useState<string | null>(null);
  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    void validateFile(filePath).then((valid) => {
      if (!cancelled) setCheckedPath(valid ? filePath : null);
    });
    return () => { cancelled = true; };
  }, [filePath]);
  if (!external && (!filePath || checkedPath !== filePath)) return <span>{children}</span>;
  return <a href={external ?? href} data-local-file-path={external ? undefined : filePath!} title={title}>{children}</a>;
}
