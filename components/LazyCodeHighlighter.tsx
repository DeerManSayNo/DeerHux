"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";
import { useTheme } from "@/hooks/useTheme";

type Runtime = {
  Prism: typeof import("react-syntax-highlighter")["Prism"];
  light: Record<string, CSSProperties>;
  dark: Record<string, CSSProperties>;
};

let cached: Runtime | null = null;
let pending: Promise<Runtime> | null = null;

function loadHighlighter(): Promise<Runtime> {
  // Direct entry points avoid loading the unused HLJS engine and theme barrel.
  pending ??= Promise.all([
    import("react-syntax-highlighter/dist/esm/prism"),
    import("react-syntax-highlighter/dist/esm/styles/prism/vs"),
    import("react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus"),
  ]).then(([prism, light, dark]) => {
    cached = { Prism: prism.default, light: light.default, dark: dark.default };
    return cached;
  }).catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

type Props = Pick<SyntaxHighlighterProps,
  "language" | "showLineNumbers" | "lineProps" | "lineNumberStyle" |
  "customStyle" | "codeTagProps" | "wrapLines" | "wrapLongLines"
> & { code: string };

export function DeferredCodeBlock({ code, ...props }: Props) {
  const { isDark } = useTheme();
  const [runtime, setRuntime] = useState<Runtime | null>(cached);
  useEffect(() => {
    let active = true;
    void loadHighlighter().then((loaded) => {
      if (active) setRuntime(loaded);
    }).catch(() => { /* Keep the readable fallback on network failure. */ });
    return () => { active = false; };
  }, []);

  const theme = useMemo(() => {
    if (!runtime) return undefined;
    const base = isDark ? runtime.dark : runtime.light;
    const pre = { ...base['pre[class*="language-"]'] };
    delete pre.background;
    return { ...base, 'pre[class*="language-"]': pre };
  }, [runtime, isDark]);

  if (runtime) {
    const Highlighter = runtime.Prism;
    return <Highlighter {...props} style={theme}>{code}</Highlighter>;
  }

  const lines = code.split("\n");
  const numberWidth = `${String(lines.length).length + 1}em`;
  return (
    <pre style={{ overflowX: "auto", color: "var(--text)", ...props.customStyle }}>
      <code {...props.codeTagProps}>
        {lines.map((line, index) => {
          const lineNumber = index + 1;
          const lineProps = typeof props.lineProps === "function" ? props.lineProps(lineNumber) : props.lineProps;
          const numberStyle = typeof props.lineNumberStyle === "function"
            ? props.lineNumberStyle(lineNumber) : props.lineNumberStyle;
          return (
            <span key={index} {...lineProps}>
              {props.showLineNumbers && <span aria-hidden="true" style={{ display: "inline-block", minWidth: numberWidth, paddingRight: "1em", userSelect: "none", ...numberStyle }}>{lineNumber}</span>}
              {line}{index < lines.length - 1 ? "\n" : ""}
            </span>
          );
        })}
      </code>
    </pre>
  );
}
