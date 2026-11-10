import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectManifest, validatePaths, validateEntrypoints } from "../scripts/retain-package.mjs";

const paths = ["package.json", "LICENSE", "README.md", "THREAT-MODEL.md", "ACCEPTANCE.md",
  "migrations/001_wake_ledger.sql", "migrations/002_wake_phases.sql",
  "dist/index.js", "dist/index.d.ts", "dist/manifest.js", "dist/worker.js", "dist/ci-runtime.js"];
const pkg = {
  version: "0.2.0", main: "./dist/index.js", types: "./dist/index.d.ts",
  exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
  paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
};
const manifest = { id: "togetherweown.pr-doer-wake", version: "0.2.0", apiVersion: 1,
  entrypoints: { worker: "./dist/worker.js" } };

test("allows only the intended package payload", () => {
  validatePaths(paths);
  for (const unexpected of [".npmrc", ".env", "trace.json", "src/index.ts", "dist/.env", "dist/trace.json",
    "dist/../index.js", "/dist/index.js", "dist/nested/file.js", "dist/index.js\n.env"]) {
    assert.throws(() => validatePaths([...paths, unexpected]), /Unexpected package member/);
  }
  assert.throws(() => validatePaths([...paths, paths[0]]), /Duplicate/);
  assert.throws(() => validatePaths(paths.slice(1)), /Missing package.json/);
  assert.throws(() => validatePaths([]), /count/);
  assert.throws(() => validatePaths(Array(101).fill("dist/index.js")), /count/);
});

test("loads the declared manifest and rejects an existing non-manifest module", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-wake-manifest-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "dist/manifest.js"), `export default ${JSON.stringify(manifest)};\n`);
  writeFileSync(join(dir, "dist/ci-runtime.js"), "export default {};\n");
  assert.equal((await inspectManifest(dir, pkg, paths)).manifest.id, manifest.id);
  const wrong = { ...pkg, paperclipPlugin: { ...pkg.paperclipPlugin, manifest: "./dist/ci-runtime.js" } };
  await assert.rejects(inspectManifest(dir, wrong, paths), /Invalid entrypoint/);
});

test("validates packed entrypoint existence and manifest identity", () => {
  assert.equal(validateEntrypoints(pkg, manifest, paths).length, 7);
  assert.throws(() => validateEntrypoints(pkg, manifest, paths.filter((path) => path !== "dist/worker.js")), /Missing entrypoint/);
  assert.throws(() => validateEntrypoints({ ...pkg, main: "../worker.js" }, manifest, paths), /Invalid entrypoint/);
  assert.throws(() => validateEntrypoints({ ...pkg, exports: {} }, manifest, paths), /Invalid entrypoint/);
  assert.throws(() => validateEntrypoints(pkg, { ...manifest, id: "wrong.plugin" }, paths));
  assert.throws(() => validateEntrypoints(pkg, { ...manifest, version: "0.1.0" }, paths));
  assert.throws(() => validateEntrypoints(pkg, { ...manifest, apiVersion: 2 }, paths));
  assert.throws(() => validateEntrypoints(pkg, { ...manifest, entrypoints: { worker: "./dist/index.js" } }, paths));
});
