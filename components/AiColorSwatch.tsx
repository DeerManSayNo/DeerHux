import type { ReactNode } from "react";

const CSS_HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;

export function parseCssHexColor(value: string): string | null {
  const color = value.trim();
  return CSS_HEX_COLOR.test(color) ? color : null;
}

export function AiColorSwatch({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="ai-color-literal">
      {children}
      <span
        className="ai-color-swatch"
        style={{ backgroundColor: color }}
        title={`颜色 ${color}`}
        aria-hidden="true"
      />
    </span>
  );
}
