import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanNpmCliPackages, listSystemClis, removeSystemCli } from "../lib/system-cli.ts";
import { DELETE } from "../app/api/system-clis/route.ts";
const scratch = await mkdtemp(path.join(tmpdir(), "deerhux-npm-clis-"));
const root = path.join(scratch, "node_modules");
async function pkg(name: string, bin?: unknown, extra: Record<string, unknown> = {}) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", bin, ...extra }));
}
try {
  await pkg("@example/browser", { webcmd: "bin/cli.js", browser: "bin/cli.js" });
  await pkg("feishu-cli", "bin/cli.js");
  await pkg("library-without-cli");
  await pkg("npm", { npm: "bin/npm-cli.js", npx: "bin/npx-cli.js" });
  const linked = path.join(scratch, "linked-source");
  await mkdir(linked);
  await writeFile(path.join(linked, "package.json"), JSON.stringify({ name: "linked-cli", bin: { linked: "cli.js" } }));
  await symlink(linked, path.join(root, "linked-cli"), process.platform === "win32" ? "junction" : "dir");
  await pkg("@example/lark-extension", undefined, {
    pi: { extensions: ["./index.ts"] },
    dependencies: { "@larksuite/cli": "1.0.87" },
    peerDependencies: { "peer-tool": "*" },
  });
  const extensionModules = path.join(root, "@example/lark-extension/node_modules");
  for (const [name, bin] of [["@larksuite/cli", { "lark-cli": "scripts/run.js" }], ["peer-tool", { peer: "cli.js" }], ["transitive-tool", { internal: "cli.js" }]] as const) {
    const dir = path.join(extensionModules, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.87", bin }));
  }
  const items = await scanNpmCliPackages(root);
  assert.equal(items.length, 5, "one row per CLI package, libraries excluded");
  assert.ok(items.every((item) => item.source === "npm"));
  const extension = items.find((item) => item.packageName === "@example/lark-extension")!;
  assert.deepEqual(extension.commands, ["lark-cli"], "only declared bundled runtime CLIs are included");
  assert.equal(extension.bundledClis?.[0].packageName, "@larksuite/cli");
  assert.equal(extension.bundledClis?.[0].version, "1.0.87");
  assert.equal(extension.path, path.join(root, "@example/lark-extension"), "uninstall identity remains the owning global package");
  assert.deepEqual(items.find((item) => item.packageName === "@example/browser")?.commands, ["browser", "webcmd"]);
  assert.equal(items.find((item) => item.packageName === "feishu-cli")?.name, "feishu-cli");
  assert.equal(items.find((item) => item.packageName === "linked-cli")?.realPath, await import("node:fs/promises").then((fs) => fs.realpath(linked)));
  assert.equal(items.find((item) => item.packageName === "npm")?.removable, false);
  assert.deepEqual(await scanNpmCliPackages(path.join(scratch, "missing")), []);
  const live = await listSystemClis();
  assert.ok(live.every((item) => item.source === "npm"));
  await assert.rejects(removeSystemCli("/bin/sh", "/bin/sh", "sh"), /不允许删除/);
  const response = await DELETE(new Request("http://localhost:30141/api/system-clis", { method: "DELETE", headers: { origin: "https://example.com" }, body: JSON.stringify({ path: "/bin/sh", realPath: "/bin/sh" }) }));
  assert.equal(response.status, 403);
  console.log(JSON.stringify(live.map((item) => ({ package: item.packageName, commands: item.commands, bundledClis: item.bundledClis }))));
  console.log("npm CLI discovery, package grouping, links, library exclusion and deletion validation passed; no installed tools removed");
} finally { await rm(scratch, { recursive: true, force: true }); }
