#!/usr/bin/env node
// Downloads and checksum-verifies a portable Windows x64 Node.js binary, staged
// as a Tauri `externalBin` sidecar (see CLAUDE.md / plan: "Ship a Node-independent
// Windows build"). This lets the shipped app run the sidecar runtime without
// requiring the end user to have Node.js installed — this script itself runs
// with the *build machine's* Node, a build-time dependency only.
//
// Pinned to match sidecar/package.json's own ^24.0.0 engines-style target (which
// was itself bumped to track this dev machine's actual Node runtime). Bump this
// constant when you want to move the bundled Node forward; nothing else in the
// build depends on the exact patch version.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import * as path from "node:path";
import * as url from "node:url";

const NODE_VERSION = "24.14.1";
const TARGET_TRIPLE = "x86_64-pc-windows-msvc";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const outDir = path.join(repoRoot, "src-tauri", "binaries");
const outFile = path.join(outDir, `sidecar-node-${TARGET_TRIPLE}.exe`);

const distBase = `https://nodejs.org/dist/v${NODE_VERSION}`;
const nodeExeUrl = `${distBase}/win-x64/node.exe`;
const shasumsUrl = `${distBase}/SHASUMS256.txt`;

async function fetchText(fetchUrl) {
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`GET ${fetchUrl} -> ${res.status} ${res.statusText}`);
  return res.text();
}

async function downloadTo(fetchUrl, destPath) {
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`GET ${fetchUrl} -> ${res.status} ${res.statusText}`);
  await pipeline(res.body, createWriteStream(destPath));
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  if (existsSync(outFile)) {
    const shasums = await fetchText(shasumsUrl);
    const expected = expectedHashFor(shasums, "win-x64/node.exe");
    if (sha256File(outFile) === expected) {
      console.log(`[fetch-node] ${outFile} already present and verified (v${NODE_VERSION}), skipping download.`);
      return;
    }
    console.log(`[fetch-node] ${outFile} exists but checksum mismatch — re-downloading.`);
  }

  console.log(`[fetch-node] downloading node v${NODE_VERSION} (win-x64) ...`);
  const tmpFile = `${outFile}.download`;
  await downloadTo(nodeExeUrl, tmpFile);

  console.log(`[fetch-node] verifying checksum ...`);
  const shasums = await fetchText(shasumsUrl);
  const expected = expectedHashFor(shasums, "win-x64/node.exe");
  const actual = sha256File(tmpFile);
  if (actual !== expected) {
    throw new Error(
      `[fetch-node] checksum mismatch for win-x64/node.exe: expected ${expected}, got ${actual}. Refusing to stage an unverified binary.`,
    );
  }

  const { renameSync } = await import("node:fs");
  renameSync(tmpFile, outFile);
  console.log(`[fetch-node] staged ${outFile} (sha256 ${actual})`);
}

function expectedHashFor(shasumsText, relativePath) {
  const line = shasumsText.split("\n").find((l) => l.trim().endsWith(relativePath));
  if (!line) throw new Error(`[fetch-node] could not find "${relativePath}" in SHASUMS256.txt`);
  const hash = line.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`[fetch-node] malformed hash line: ${line}`);
  return hash;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
