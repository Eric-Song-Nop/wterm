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
const ADAPTER_ABI_VERSION = 4;
const GHOSTTY_FORK_REPOSITORY = "Eric-Song-Nop/ghostty";
const GHOSTTY_UPSTREAM_BASE_COMMIT = "f2d5758f6305867dc36b36293c6165d8152b853e";
const TERMINAL_PROFILE = Object.freeze({
  colorScheme: "derived-from-background",
  deviceAttributes: "VT220+ANSI-color",
  term: "xterm-256color",
  xtversion: "wterm 0.3.4",
});

const OPENING_DELIMITERS = Object.freeze({
  "(": ")",
  "[": "]",
  "{": "}",
});
const CLOSING_DELIMITERS = new Set(Object.values(OPENING_DELIMITERS));

function decodeEscape(source, offset) {
  const escape = source[offset];
  const simple = {
    0: "\0",
    "\\": "\\",
    '"': '"',
    "'": "'",
    n: "\n",
    r: "\r",
    t: "\t",
  }[escape];
  if (simple !== undefined) return { next: offset + 1, value: simple };

  if (escape === "x") {
    const digits = source.slice(offset + 1, offset + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(digits)) {
      throw new Error("Invalid hexadecimal escape in zig/build.zig.zon");
    }
    return {
      next: offset + 3,
      value: String.fromCharCode(Number.parseInt(digits, 16)),
    };
  }

  if (escape === "u" && source[offset + 1] === "{") {
    const close = source.indexOf("}", offset + 2);
    const digits = close < 0 ? "" : source.slice(offset + 2, close);
    if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) {
      throw new Error("Invalid Unicode escape in zig/build.zig.zon");
    }
    const codepoint = Number.parseInt(digits, 16);
    if (codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
      throw new Error("Invalid Unicode scalar in zig/build.zig.zon");
    }
    return { next: close + 1, value: String.fromCodePoint(codepoint) };
  }

  throw new Error("Unsupported string escape in zig/build.zig.zon");
}

function readStringToken(source, start) {
  let offset = start + 1;
  let value = "";
  while (offset < source.length) {
    const character = source[offset];
    if (character === '"') {
      return {
        next: offset + 1,
        token: { kind: "string", offset: start, value },
      };
    }
    if (character === "\n" || character === "\r") {
      throw new Error("Unterminated string in zig/build.zig.zon");
    }
    if (character === "\\") {
      const decoded = decodeEscape(source, offset + 1);
      value += decoded.value;
      offset = decoded.next;
      continue;
    }
    value += character;
    offset += 1;
  }
  throw new Error("Unterminated string in zig/build.zig.zon");
}

function isIdentifierStart(character) {
  return character !== undefined && /[A-Za-z_]/.test(character);
}

function isIdentifierContinue(character) {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function tokenizeZon(source) {
  const tokens = [];
  let offset = 0;
  while (offset < source.length) {
    const character = source[offset];
    if (/\s/.test(character)) {
      offset += 1;
      continue;
    }
    if (character === "/" && source[offset + 1] === "/") {
      const newline = source.indexOf("\n", offset + 2);
      offset = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (character === '"') {
      const parsed = readStringToken(source, offset);
      tokens.push(parsed.token);
      offset = parsed.next;
      continue;
    }
    if (character === "." && isIdentifierStart(source[offset + 1])) {
      let end = offset + 2;
      while (isIdentifierContinue(source[end])) end += 1;
      tokens.push({
        kind: "field",
        offset,
        value: source.slice(offset + 1, end),
      });
      offset = end;
      continue;
    }
    if (".{}[]()=,".includes(character)) {
      tokens.push({ kind: "symbol", offset, value: character });
      offset += 1;
      continue;
    }

    let end = offset + 1;
    while (
      end < source.length &&
      !/\s/.test(source[end]) &&
      !'.{}[]()=,"'.includes(source[end]) &&
      !(source[end] === "/" && source[end + 1] === "/")
    ) {
      end += 1;
    }
    tokens.push({
      kind: "atom",
      offset,
      value: source.slice(offset, end),
    });
    offset = end;
  }
  return tokens;
}

function isSymbol(token, value) {
  return token?.kind === "symbol" && token.value === value;
}

function findValueEnd(tokens, start, limit, label) {
  const expectedClosers = [];
  for (let index = start; index < limit; index += 1) {
    const token = tokens[index];
    if (token.kind !== "symbol") continue;
    const closer = OPENING_DELIMITERS[token.value];
    if (closer) {
      expectedClosers.push(closer);
      continue;
    }
    if (CLOSING_DELIMITERS.has(token.value)) {
      if (expectedClosers.pop() !== token.value) {
        throw new Error(`Unbalanced delimiters in ${label}`);
      }
      continue;
    }
    if (token.value === "," && expectedClosers.length === 0) return index;
  }
  if (expectedClosers.length !== 0) {
    throw new Error(`Unbalanced delimiters in ${label}`);
  }
  return limit;
}

function parseStructFields(tokens, start, end, label) {
  if (
    !isSymbol(tokens[start], ".") ||
    !isSymbol(tokens[start + 1], "{") ||
    !isSymbol(tokens[end - 1], "}")
  ) {
    throw new Error(`${label} must be a struct initializer`);
  }

  const fields = [];
  let index = start + 2;
  const limit = end - 1;
  while (index < limit) {
    if (isSymbol(tokens[index], ",")) {
      index += 1;
      continue;
    }
    const field = tokens[index];
    if (field?.kind !== "field" || !isSymbol(tokens[index + 1], "=")) {
      throw new Error(`${label} contains an invalid field declaration`);
    }
    const valueStart = index + 2;
    const valueEnd = findValueEnd(tokens, valueStart, limit, label);
    if (valueStart === valueEnd) {
      throw new Error(`${label} contains an empty .${field.value} value`);
    }
    fields.push({ name: field.value, valueEnd, valueStart });
    index = valueEnd;
    if (isSymbol(tokens[index], ",")) index += 1;
  }
  return fields;
}

function uniqueField(fields, name, label) {
  const matches = fields.filter((field) => field.name === name);
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one .${name} field`);
  }
  return matches[0];
}

function stringFieldValue(tokens, fields, name, label) {
  const field = uniqueField(fields, name, label);
  if (
    field.valueEnd !== field.valueStart + 1 ||
    tokens[field.valueStart]?.kind !== "string"
  ) {
    throw new Error(`${label} .${name} must be a string literal`);
  }
  return tokens[field.valueStart].value;
}

function nestedStructFields(tokens, field, label) {
  return parseStructFields(tokens, field.valueStart, field.valueEnd, label);
}

export function validateGhosttyArchiveUrl(value) {
  let archive;
  try {
    archive = new URL(value);
  } catch {
    throw new Error("Ghostty dependency URL must be an absolute URL");
  }
  if (archive.protocol !== "https:") {
    throw new Error("Ghostty dependency URL must use HTTPS");
  }
  if (archive.hostname !== "github.com") {
    throw new Error("Ghostty dependency URL hostname must be github.com");
  }
  if (archive.username || archive.password) {
    throw new Error("Ghostty dependency URL must not contain credentials");
  }
  if (archive.port) {
    throw new Error("Ghostty dependency URL must not contain a port");
  }
  if (archive.search || archive.hash) {
    throw new Error(
      "Ghostty dependency URL must not contain query or hash data",
    );
  }

  const pathname = new RegExp(
    `^/${GHOSTTY_FORK_REPOSITORY}/archive/([0-9a-f]{40})\\.tar\\.gz$`,
  ).exec(archive.pathname);
  if (!pathname) {
    throw new Error(
      `Ghostty dependency URL path must be /${GHOSTTY_FORK_REPOSITORY}/archive/<40hex>.tar.gz`,
    );
  }
  const ghosttyCommit = pathname[1];
  const canonical =
    `https://github.com/${GHOSTTY_FORK_REPOSITORY}/archive/` +
    `${ghosttyCommit}.tar.gz`;
  if (value !== canonical) {
    throw new Error("Ghostty dependency URL must use its canonical form");
  }
  return {
    ghosttyCommit,
    ghosttyRepository: GHOSTTY_FORK_REPOSITORY,
  };
}

export function parseGhosttyDependency(source) {
  const tokens = tokenizeZon(source);
  const root = parseStructFields(tokens, 0, tokens.length, "zig/build.zig.zon");
  const dependencies = nestedStructFields(
    tokens,
    uniqueField(root, "dependencies", "zig/build.zig.zon"),
    "zig/build.zig.zon .dependencies",
  );
  const ghostty = nestedStructFields(
    tokens,
    uniqueField(dependencies, "ghostty", "zig/build.zig.zon .dependencies"),
    "zig/build.zig.zon .dependencies .ghostty",
  );
  const url = stringFieldValue(
    tokens,
    ghostty,
    "url",
    "zig/build.zig.zon .dependencies .ghostty",
  );
  const ghosttyPackageHash = stringFieldValue(
    tokens,
    ghostty,
    "hash",
    "zig/build.zig.zon .dependencies .ghostty",
  );
  if (!/^ghostty-[A-Za-z0-9._+-]+$/.test(ghosttyPackageHash)) {
    throw new Error("Ghostty dependency .hash has an invalid package hash");
  }
  const zigVersion = stringFieldValue(
    tokens,
    root,
    "minimum_zig_version",
    "zig/build.zig.zon",
  );
  return {
    ...validateGhosttyArchiveUrl(url),
    ghosttyPackageHash,
    zigVersion,
  };
}

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
  const { ghosttyCommit, ghosttyPackageHash, ghosttyRepository, zigVersion } =
    parseGhosttyDependency(zon);
  const dependencyRoot = path.join(ZIG_DIR, "zig-pkg", ghosttyPackageHash);
  const existing = await readExistingManifest();
  const patches =
    ghosttyCommit === GHOSTTY_UPSTREAM_BASE_COMMIT
      ? []
      : [
          canonicalize({
            baseCommit: GHOSTTY_UPSTREAM_BASE_COMMIT,
            commit: ghosttyCommit,
            id: "ansi-decrqm-dispatch",
            repository: GHOSTTY_FORK_REPOSITORY,
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

async function main(mode) {
  if (mode === "prepare") {
    const provenance = await buildSourceProvenance({
      allowMissingDependency: false,
    });
    await writeFile(
      ZIG_ENGINE_PATH,
      renderZig(buildIdFor(provenance), provenance.terminalProfile),
    );
  } else if (mode === "finalize") {
    const artifacts = await expectedArtifacts({
      allowMissingDependency: false,
    });
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main(process.argv[2]);
}
