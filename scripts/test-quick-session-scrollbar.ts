import assert from "node:assert/strict";
import { scrollbarOffset } from "../lib/quick-session-scrollbar.ts";

// Six 360px cards with padding/gaps in a 380px window.
const contentWidth = 2230;
const viewportWidth = 380;
const trackWidth = 360;
const thumbWidth = trackWidth * viewportWidth / contentWidth;
const travel = trackWidth - thumbWidth;
const maximumOffset = contentWidth - viewportWidth;
assert.equal(scrollbarOffset(0, travel, maximumOffset), 0);
assert.equal(scrollbarOffset(travel, travel, maximumOffset), 1850);
assert.equal(scrollbarOffset(travel / 2, travel, maximumOffset), 925);
assert.equal(scrollbarOffset(-100, travel, maximumOffset), 0);
assert.equal(scrollbarOffset(travel + 100, travel, maximumOffset), 1850);
assert.equal(scrollbarOffset(100, 0, 0), 0);
assert.equal(scrollbarOffset(100, 0, 1850), 0);
assert.equal(scrollbarOffset(100, 300, 0), 0);
// Minimum-size thumb and expanded three-card viewport use the same mapping.
assert.equal(scrollbarOffset(72, 100 - 28, 5000), 5000);
assert.equal(scrollbarOffset(400, 800, 1110), 555);
console.log("quick-session scrollbar: 10 assertions passed");
