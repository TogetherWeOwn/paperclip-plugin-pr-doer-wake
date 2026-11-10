import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requiredFiles = ["package.json", "LICENSE", "README.md", "THREAT-MODEL.md", "ACCEPTANCE.md",
  "migrations/001_wake_ledger.sql", "migrations/002_wake_phases.sql"];

export function validatePaths(paths) {
  assert(paths.length > 0 && paths.length <= 100, "Unexpected package file count");
  assert.equal(new Set(paths).size, paths.length, "Duplicate package member");
  for (const path of paths) {
    assert(requiredFiles.includes(path) || /^dist\/[a-z][a-z-]*(?:\.js|\.d\.ts)$/.test(path),
      `Unexpected package member: ${path}`);
  }
  for (const path of requiredFiles) assert(paths.includes(path), `Missing ${path}`);
}

export function validateEntrypoints(pkg, manifest, paths) {
  const entrypoints = [pkg.main, pkg.types, pkg.exports?.["."]?.import, pkg.exports?.["."]?.types,
    pkg.paperclipPlugin?.manifest, pkg.paperclipPlugin?.worker, manifest.entrypoints?.worker];
  for (const path of entrypoints) {
    assert(typeof path === "string" && path.startsWith("./dist/"), "Invalid entrypoint");
    assert(paths.includes(path.slice(2)), `Missing entrypoint: ${path}`);
  }
  assert.equal(pkg.paperclipPlugin.worker, manifest.entrypoints.worker);
  assert.equal(manifest.id, "togetherweown.pr-doer-wake");
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.version, pkg.version);
  return entrypoints;
}

const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options,
}).trim();
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (dir, name, data) => writeFileSync(join(dir, name), `${JSON.stringify(data, null, 2)}\n`);

export async function retainPackage(outputDir) {
  const root = process.cwd();
  const env = process.env;
  for (const name of ["SOURCE_SHA", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
    "GITHUB_SERVER_URL", "GITHUB_WORKFLOW_REF", "GITHUB_WORKFLOW_SHA", "GITHUB_JOB"]) {
    assert(env[name], `Missing Actions context: ${name}`);
  }
  const sourceSha = run("git", ["rev-parse", "HEAD"]);
  assert.equal(sourceSha, env.SOURCE_SHA, "Checkout is not the requested source");
  run("git", ["diff", "--exit-code", "HEAD", "--", "."]);
  mkdirSync(outputDir);
  // Keep extraction under the project so Node resolves the locked SDK, without
  // copying dependencies into the package or executing the worker/host protocol.
  const inspectionDir = mkdtempSync(join(root, ".package-inspection-"));
  try {
    const [packed] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", outputDir]));
    assert(/^[a-z0-9.-]+\.tgz$/.test(packed.filename), "Invalid tarball filename");
    const tarball = join(outputDir, packed.filename);
    const members = run("tar", ["-tzf", tarball]).split("\n");
    assert(members.every((path) => path.startsWith("package/")), "Invalid archive prefix");
    const paths = members.map((path) => path.slice("package/".length));
    validatePaths(paths);
    // npm produces regular files only. Refuse links/devices before extraction.
    const modes = run("tar", ["-tvzf", tarball]).split("\n");
    assert.equal(modes.length, paths.length);
    assert(modes.every((line) => line.startsWith("-")), "Non-regular archive member");
    assert.deepEqual([...paths].sort(), packed.files.map((file) => file.path).sort());
    run("tar", ["-xzf", tarball, "--no-same-owner", "--no-same-permissions", "-C", inspectionDir]);
    const packageDir = join(inspectionDir, "package");
    const inventory = paths.sort().map((path) => {
      const bytes = readFileSync(join(packageDir, path));
      assert.deepEqual(bytes, readFileSync(join(root, path)), `Packed bytes differ: ${path}`);
      return { path, size: bytes.length, sha256: sha256(bytes) };
    });
    const pkg = json(join(packageDir, "package.json"));
    const { default: manifest } = await import(pathToFileURL(join(packageDir, "dist/manifest.js")).href);
    const entrypoints = validateEntrypoints(pkg, manifest, paths);
    const exported = await import(pathToFileURL(join(packageDir, pkg.exports["."].import)).href);
    assert.equal(exported.manifest.id, manifest.id);
    assert(exported.plugin && typeof exported.CiWakeRuntime === "function", "Invalid public exports");
    run(process.execPath, ["--check", join(packageDir, pkg.paperclipPlugin.worker)]);
    const lock = json(join(root, "package-lock.json"));
    const dependencies = Object.entries(lock.packages).filter(([path]) => path.startsWith("node_modules/")).map(([path, locked]) => {
      const installed = join(root, path, "package.json");
      const version = existsSync(installed) ? json(installed).version : null;
      if (version !== null) assert.equal(version, locked.version, `Installed version drift: ${path}`);
      else assert(locked.optional, `Missing locked dependency: ${path}`);
      return { path, lockedVersion: locked.version, installedVersion: version, integrity: locked.integrity };
    });
    const sdk = dependencies.find((dep) => dep.path === "node_modules/@paperclipai/plugin-sdk");
    assert(sdk?.installedVersion, "SDK not installed");
    const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
    save(outputDir, "package-files.json", inventory);
    save(outputDir, "validation.json", {
      result: "passed", package: pkg.name, version: pkg.version, manifestId: manifest.id, entrypoints,
      checks: ["regular-file allowlist", "packed bytes match built workspace", "manifest and package entrypoints exist",
        "manifest version and worker agree", "packed public entrypoint imports with locked SDK", "worker syntax"],
      limits: "Worker not started; no host installation, governance, configuration or canary acceptance implied.",
    });
    save(outputDir, "provenance.json", {
      schemaVersion: 1, sourceSha, repository: env.GITHUB_REPOSITORY,
      workflowRef: env.GITHUB_WORKFLOW_REF, workflowSha: env.GITHUB_WORKFLOW_SHA,
      event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
      runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, runUrl,
      job: env.GITHUB_JOB, attemptUrl: `${runUrl}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
      node: process.version, npm: run("npm", ["--version"]), sdk: sdk.installedVersion, dependencies,
      lockfileSha256: sha256(readFileSync(join(root, "package-lock.json"))),
      tarball: { filename: packed.filename, sha256: sha256(readFileSync(tarball)), size: readFileSync(tarball).length },
      retentionDays: 30,
      qualification: "Build evidence only. Require successful run/job conclusion and artifact API receipt externally; PR artifacts are not merged-source qualification.",
    });
    const files = [packed.filename, "package-files.json", "validation.json", "provenance.json"];
    writeFileSync(join(outputDir, "SHA256SUMS"), files.map((name) => `${sha256(readFileSync(join(outputDir, name)))}  ${name}\n`).join(""));
  } finally {
    rmSync(inspectionDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv[2], "Usage: node scripts/retain-package.mjs <new-output-directory>");
  await retainPackage(resolve(process.argv[2]));
}
