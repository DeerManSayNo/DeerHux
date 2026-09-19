import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AiColorSwatch, parseCssHexColor } from "../components/AiColorSwatch";

for (const color of ["#abc", "#ABCD", "#12ab34", "#12AB34cd", "  #ffb067  "]) {
  assert.equal(parseCssHexColor(color), color.trim());
}

for (const value of ["ffb067", "#12", "#12345", "#1234567", "#ggg", "red", "var(--accent)", "#abc extra"]) {
  assert.equal(parseCssHexColor(value), null, value);
}

const markup = renderToStaticMarkup(
  <AiColorSwatch color="#ffb067"><code className="inline-code">#ffb067</code></AiColorSwatch>,
);
assert.match(markup, /class="ai-color-literal"/);
assert.match(markup, /class="ai-color-swatch"/);
assert.match(markup, /background-color:#ffb067/);
assert.equal((markup.match(/#ffb067/g) ?? []).length, 3);

console.log("AI color swatch tests passed");
