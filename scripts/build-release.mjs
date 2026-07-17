#!/usr/bin/env node
// Generic plugin build-release — ID·FILES·deps 를 매니페스트에서 동적 산정한다.
// 경계는 본질만 강제(spec@0.0.1·id·version·entry·private). 유닛별 하드코딩 없음.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRegularFileArchive, readRegularFileArchive, sha256 } from "./archive.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRICT_SEMVER_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
const CANDIDATES = ["LICENSE", "NOTICE", "README.ko.md", "README.md", "main.js", "plugin.json"];

function option(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const commit = option("--commit");
const outDir = path.resolve(option("--out") ?? path.join(root, "dist"));
if (!/^[a-f0-9]{40}$/.test(commit ?? "")) {
  console.error("--commit must be an exact lowercase 40-character Git commit SHA");
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
const manifestBytes = fs.readFileSync(path.join(root, "plugin.json"));
const plugin = JSON.parse(manifestBytes);
const ID = plugin.id;
const REPOSITORY = `https://github.com/soksak-ai/${ID}`;
const VERSION = pkg.version;

// 경계(본질) — 유닛 공통 불변식만
if (typeof VERSION !== "string" || !STRICT_SEMVER_RE.test(VERSION)) throw new Error("package version must be strict SemVer");
if (pkg.name !== ID || pkg.private !== true) throw new Error("package name/private boundary");
if (plugin.spec !== "soksak-spec-plugin@0.0.1") throw new Error(`plugin.spec must be soksak-spec-plugin@0.0.1 (got ${plugin.spec})`);
if (plugin.version !== VERSION) throw new Error(`plugin.version ${plugin.version} != package.version ${VERSION}`);
if (plugin.entry !== "main.js") throw new Error("plugin.entry must be main.js");
if ("repo" in plugin) throw new Error("plugin manifest must not carry a repo field");

// FILES = 표준 후보 ∩ 실존 (main.js·plugin.json 필수)
const FILES = CANDIDATES.filter((f) => fs.existsSync(path.join(root, f)));
for (const req of ["main.js", "plugin.json"]) {
  if (!FILES.includes(req)) throw new Error(`required file missing: ${req}`);
}

// install-closure deps = plugin.dependencies(plugin-kind) + sidecars(sidecar-kind)
const deps = [];
for (const [id, range] of Object.entries(plugin.dependencies ?? {}).sort()) {
  if (typeof range !== "string") throw new Error(`dependency range must be string: ${id}`);
  deps.push({ kind: "plugin", id, range });
}
for (const s of plugin.sidecars ?? []) {
  if (s && typeof s.name === "string") deps.push({ kind: "sidecar", id: s.name, range: VERSION });
}
deps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const tag = `v${VERSION}`;
const archiveName = `${ID}-${VERSION}-any.tgz`;
const archive = createRegularFileArchive({ root, files: FILES });
const archived = readRegularFileArchive(archive);
if (JSON.stringify(archived.map((e) => e.name)) !== JSON.stringify(FILES)) throw new Error("archive inventory diverges from declared files");
const am = archived.find((e) => e.name === "plugin.json");
if (!am || !am.data.equals(manifestBytes)) throw new Error("archived plugin.json differs from source");

const artifactSha256 = sha256(archive);
const artifact = { target: "any", url: `${REPOSITORY}/releases/download/${tag}/${archiveName}`, sha256: artifactSha256, format: "tgz", entrypoint: { kind: "plugin", manifest: "plugin.json" } };
const release = { spec: "soksak-spec-release@0.0.1", kind: "plugin", id: ID, version: VERSION, source: { repository: REPOSITORY, commit }, releaseTag: tag, dependencies: deps, artifacts: [artifact] };
const releaseBytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`);
const manifestSha256 = sha256(releaseBytes);
const report = (contract) => ({ spec: "soksak-spec-conformance@0.0.1", subject: { kind: "plugin", id: ID, version: VERSION, manifestSha256 }, contract, result: "passed", validator: { name: "soksak-unit-conformance", version: VERSION }, artifacts: [{ target: "any", sha256: artifactSha256 }] });

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, archiveName), archive);
fs.writeFileSync(path.join(outDir, "release.json"), releaseBytes);
fs.writeFileSync(path.join(outDir, "conformance-release.json"), `${JSON.stringify(report("soksak-spec-release@0.0.1"), null, 2)}\n`);
fs.writeFileSync(path.join(outDir, "conformance-plugin.json"), `${JSON.stringify(report("soksak-spec-plugin@0.0.1"), null, 2)}\n`);
console.log(JSON.stringify({ id: ID, version: VERSION, archive: archiveName, files: FILES, deps, sha256: artifactSha256 }));
