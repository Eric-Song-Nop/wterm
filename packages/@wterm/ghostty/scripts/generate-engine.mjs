#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..");
const ZIG_DIR = path.join(PACKAGE_DIR, "zig");
const ZON_PATH = path.join(ZIG_DIR, "build.zig.zon");
const WASM_PATH = path.join(PACKAGE_DIR, "wasm", "ghostty-vt.wasm");
const MANIFEST_PATH = path.join(PACKAGE_DIR, "engine-manifest.json");
const TS_PATH = path.join(PACKAGE_DIR, "src", "engine.ts");
const ZIG_ENGINE_PATH = path.join(ZIG_DIR, "src", "engine_manifest.zig");
const ADAPTER_ABI_VERSION = 2;
const GHOSTTY_UPSTREAM_BASE_COMMIT = "f2d5758f6305867dc36b36293c6165d8152b853e";
const TERMINAL_PROFILE = Object.freeze({
  colorScheme: "derived-from-background",
  deviceAttributes: "VT220+ANSI-color",
  term: "xterm-256color",
  xtversion: "wterm 0.3.4",
});

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

async function hashFile(filePath) {
  return sha256(await readFile(filePath));
}

async function hashTree(root) {
  const hash = createHash("sha256");

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        hash.update(`D\0${relative}\0`);
        await visit(absolute);
      } else if (stat.isSymbolicLink()) {
        hash.update(`L\0${relative}\0${await readlink(absolute)}\0`);
      } else if (stat.isFile()) {
        const contents = await readFile(absolute);
        hash.update(`F\0${relative}\0${contents.byteLength}\0`);
        hash.update(contents);
      }
    }
  }

  await visit(root);
  return hash.digest("hex");
}

function requiredMatch(text, expression, label) {
  const match = text.match(expression);
  if (!match) throw new Error(`Cannot read ${label} from zig/build.zig.zon`);
  return match[1];
}

async function readExistingManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function buildSourceProvenance({ allowMissingDependency }) {
  const zon = await readFile(ZON_PATH, "utf8");
  const ghosttyPackageHash = requiredMatch(
    zon,
    /\.hash\s*=\s*"(ghostty-[^"]+)"/,
    "Ghostty package hash",
  );
  const archive = zon.match(
    /github\.com\/([^/"]+\/ghostty)\/archive\/([0-9a-f]{40})\.tar\.gz/,
  );
  if (!archive) {
    throw new Error(
      "Cannot read the Ghostty repository and commit from zig/build.zig.zon",
    );
  }
  const [, ghosttyRepository, ghosttyCommit] = archive;
  const zigVersion = requiredMatch(
    zon,
    /\.minimum_zig_version\s*=\s*"([^"]+)"/,
    "Zig version",
  );
  const dependencyRoot = path.join(ZIG_DIR, "zig-pkg", ghosttyPackageHash);
  const existing = await readExistingManifest();
  const patches =
    ghosttyRepository === "ghostty-org/ghostty" &&
    ghosttyCommit === GHOSTTY_UPSTREAM_BASE_COMMIT
      ? []
      : [
          canonicalize({
            baseCommit: GHOSTTY_UPSTREAM_BASE_COMMIT,
            commit: ghosttyCommit,
            id: "ansi-decrqm-dispatch",
            repository: ghosttyRepository,
            upstreamPullRequest:
              "https://github.com/ghostty-org/ghostty/pull/14044",
          }),
        ];

  let ghosttySourceSha256;
  let snapshotSchemaSha256;
  try {
    ghosttySourceSha256 = await hashTree(dependencyRoot);
    snapshotSchemaSha256 = await hashFile(
      path.join(dependencyRoot, "src", "terminal", "snapshot", "snapshot.ksy"),
    );
  } catch (error) {
    if (!allowMissingDependency || error?.code !== "ENOENT" || !existing) {
      throw new Error(
        `Ghostty dependency is not fetched at ${dependencyRoot}. Run the WASM rebuild first.`,
        { cause: error },
      );
    }
    ghosttySourceSha256 = existing.provenance.ghosttySourceSha256;
    snapshotSchemaSha256 = existing.provenance.snapshotSchemaSha256;
  }

  return canonicalize({
    adapterAbiVersion: ADAPTER_ABI_VERSION,
    adapterSourceSha256: await hashFile(
      path.join(ZIG_DIR, "src", "wasm_api.zig"),
    ),
    buildSourceSha256: await hashFile(path.join(ZIG_DIR, "build.zig")),
    buildScriptSha256: await hashFile(
      path.join(PACKAGE_DIR, "scripts", "build-wasm.sh"),
    ),
    dependencyManifestSha256: sha256(zon),
    ghosttyCommit,
    ghosttyPackageHash,
    ghosttyRepository,
    ghosttySourceSha256,
    ghosttyUpstreamBaseCommit: GHOSTTY_UPSTREAM_BASE_COMMIT,
    ghosttyVtFeatures: "default",
    manifestGeneratorSha256: await hashFile(SCRIPT_PATH),
    optimize: "ReleaseSmall",
    patches,
    patchsetSha256: sha256(canonicalJson(patches)),
    snapshotSchemaSha256,
    snapshotSchemaVersion: 1,
    target: "wasm32-freestanding",
    terminalProfile: TERMINAL_PROFILE,
    unicodeWidthPolicy: "ghostty-default",
    zigVersion,
  });
}

function buildIdFor(provenance) {
  const digest = sha256(canonicalJson(provenance));
  return `ghostty:${provenance.ghosttyCommit}:wterm-build-sha256:${digest}`;
}

function engineIdFor(provenance) {
  const digest = sha256(canonicalJson(provenance));
  return `ghostty:${provenance.ghosttyCommit}:wterm-engine-sha256:${digest}`;
}

function renderZig(buildId, terminalProfile) {
  return (
    `// Generated by scripts/generate-engine.mjs. Do not edit.\n` +
    `pub const build_id = ${JSON.stringify(buildId)};\n` +
    `pub const terminal_name = ${JSON.stringify(terminalProfile.term)};\n` +
    `pub const xtversion = ${JSON.stringify(terminalProfile.xtversion)};\n`
  );
}

function renderTypeScriptValue(value, indent) {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const padding = " ".repeat(indent);
    const childPadding = " ".repeat(indent + 2);
    const entries = value
      .map(
        (child) =>
          `${childPadding}${renderTypeScriptValue(child, indent + 2)},`,
      )
      .join("\n");
    return `[\n${entries}\n${padding}]`;
  }
  if (value && typeof value === "object") {
    const padding = " ".repeat(indent);
    const entries = Object.entries(value)
      .map(([key, child]) => renderTypeScriptProperty(key, child, indent + 2))
      .join("\n");
    return `{\n${entries}\n${padding}}`;
  }
  return JSON.stringify(value);
}

function renderTypeScriptProperty(key, value, indent) {
  const padding = " ".repeat(indent);
  const rendered = renderTypeScriptValue(value, indent);
  const line = `${padding}${key}: ${rendered},`;
  if (rendered.includes("\n") || line.length <= 80) return line;
  return `${padding}${key}:\n${" ".repeat(indent + 2)}${rendered},`;
}

function renderTypeScript(manifest) {
  const provenance = Object.entries(manifest.provenance)
    .map(([key, value]) => renderTypeScriptProperty(key, value, 2))
    .join("\n");
  return (
    `// Generated by scripts/generate-engine.mjs. Do not edit.\n` +
    `export const GHOSTTY_ENGINE_PROVENANCE = Object.freeze({\n${provenance}\n} as const);\n\n` +
    `export const GHOSTTY_BUILD_ID =\n  ${JSON.stringify(manifest.buildId)};\n\n` +
    `export const GHOSTTY_ENGINE_ID =\n  ${JSON.stringify(manifest.engineId)};\n\n` +
    `export const GHOSTTY_WASM_SHA256 =\n  ${JSON.stringify(manifest.wasmSha256)};\n\n` +
    `export const GHOSTTY_TERMINAL_PROFILE =\n` +
    `  GHOSTTY_ENGINE_PROVENANCE.terminalProfile;\n\n` +
    `export const GHOSTTY_ENGINE_MANIFEST = Object.freeze({\n` +
    `  buildId: GHOSTTY_BUILD_ID,\n` +
    `  engineId: GHOSTTY_ENGINE_ID,\n` +
    `  provenance: GHOSTTY_ENGINE_PROVENANCE,\n` +
    `  wasmSha256: GHOSTTY_WASM_SHA256,\n` +
    `} as const);\n\n` +
    `export type GhosttyEngineManifest = typeof GHOSTTY_ENGINE_MANIFEST;\n`
  );
}

function renderJson(manifest) {
  return `${JSON.stringify(canonicalize(manifest), null, 2)}\n`;
}

async function expectedArtifacts({ allowMissingDependency }) {
  const sourceProvenance = await buildSourceProvenance({
    allowMissingDependency,
  });
  const buildId = buildIdFor(sourceProvenance);
  const wasmSha256 = await hashFile(WASM_PATH);
  const provenance = canonicalize({
    ...sourceProvenance,
    committedWasmSha256: wasmSha256,
  });
  const manifest = canonicalize({
    buildId,
    engineId: engineIdFor(provenance),
    provenance,
    wasmSha256,
  });
  return {
    manifest,
    zig: renderZig(buildId, provenance.terminalProfile),
    typescript: renderTypeScript(manifest),
    json: renderJson(manifest),
  };
}

async function assertFile(filePath, expected) {
  const actual = await readFile(filePath, "utf8");
  if (actual !== expected) {
    throw new Error(
      `${path.relative(PACKAGE_DIR, filePath)} is stale. Run the WASM rebuild and commit every generated artifact.`,
    );
  }
}

const mode = process.argv[2];
if (mode === "prepare") {
  const provenance = await buildSourceProvenance({
    allowMissingDependency: false,
  });
  await writeFile(
    ZIG_ENGINE_PATH,
    renderZig(buildIdFor(provenance), provenance.terminalProfile),
  );
} else if (mode === "finalize") {
  const artifacts = await expectedArtifacts({ allowMissingDependency: false });
  await assertFile(ZIG_ENGINE_PATH, artifacts.zig);
  await writeFile(TS_PATH, artifacts.typescript);
  await writeFile(MANIFEST_PATH, artifacts.json);
} else if (mode === "check") {
  const artifacts = await expectedArtifacts({ allowMissingDependency: true });
  await assertFile(ZIG_ENGINE_PATH, artifacts.zig);
  await assertFile(TS_PATH, artifacts.typescript);
  await assertFile(MANIFEST_PATH, artifacts.json);
} else {
  throw new Error("Usage: generate-engine.mjs <prepare|finalize|check>");
}
