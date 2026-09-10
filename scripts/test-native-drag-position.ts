import assert from "node:assert/strict";
import { nativeDragClientPosition } from "../lib/native-drag-position.ts";
// Three adjacent 600px session panes. The third pane must never hit the second.
for (const scale of [1, 2]) {
  for (const zoom of [0.8, 1, 1.25]) {
    for (let pane = 0; pane < 3; pane++) {
      const client = { x: pane * 600 + 300, y: 250 };
      const mac = nativeDragClientPosition({ x: client.x * zoom, y: client.y * zoom }, true, scale * zoom, scale);
      assert.equal(Math.floor(mac.x / 600), pane);
      assert.ok(Math.abs(mac.y - client.y) < 0.001);
      const windows = nativeDragClientPosition({ x: client.x * scale * zoom, y: client.y * scale * zoom }, false, scale * zoom, scale);
      assert.equal(Math.floor(windows.x / 600), pane);
    }
  }
}
assert.deepEqual(nativeDragClientPosition({ x: 1500, y: 500 }, true, 2, 2), { x: 1500, y: 500 });
console.log("Native drag coordinates: three panes, Retina and zoom checks passed");
