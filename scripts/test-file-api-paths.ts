import assert from "node:assert/strict";
import {
  encodeFilePathForApi,
  fileApiReadUrl,
  normalizeLegacyFileApiReadUrl,
} from "../lib/file-paths.ts";
import { filePathFromSegments } from "../lib/file-access.ts";

assert.equal(
  encodeFilePathForApi("C:\\work space\\项目\\image #1.png"),
  "C%3A/work%20space/%E9%A1%B9%E7%9B%AE/image%20%231.png",
);
assert.equal(
  fileApiReadUrl("C:\\work space\\image.png"),
  "/api/files/C%3A/work%20space/image.png?type=read",
);
assert.equal(
  encodeFilePathForApi("\\\\server\\share\\image.png"),
  "%5C%5Cserver/share/image.png",
);
assert.equal(filePathFromSegments(["C:", "work", "image.png"]), "C:/work/image.png");
assert.equal(filePathFromSegments(["\\\\server", "share", "image.png"]), "//server/share/image.png");
assert.equal(
  normalizeLegacyFileApiReadUrl("/api/filesC:\\work space\\image.png?type=read"),
  "/api/files/C%3A/work%20space/image.png?type=read",
);
assert.equal(
  normalizeLegacyFileApiReadUrl("/api/filesC:/work/image.png?type=read"),
  "/api/files/C%3A/work/image.png?type=read",
);
assert.equal(
  normalizeLegacyFileApiReadUrl("/api/files\\\\server\\share\\image.png?type=read"),
  "/api/files/%5C%5Cserver/share/image.png?type=read",
);
assert.equal(
  normalizeLegacyFileApiReadUrl("/api/files/Users/demo/image.png?type=read"),
  "/api/files/Users/demo/image.png?type=read",
);

console.log("file API path tests passed");
