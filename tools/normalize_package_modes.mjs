#!/usr/bin/env node

import { chmod, lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PACKAGE_FILES = 10_000;
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const OPTIONAL_LEGAL_FILES = Object.freeze([
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "NOTICE",
  "NOTICE.md",
  "NOTICE.txt",
  "THIRD_PARTY_NOTICES.md",
]);

class PackageModeError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackageModeError";
  }
}

function fail(message) {
  throw new PackageModeError(message);
}

async function inspect(path, label) {
  let value;
  try {
    value = await lstat(path);
  } catch {
    fail(`${label} metadata is unavailable`);
  }
  if (value.isSymbolicLink()) fail(`${label} is a symbolic link`);
  return value;
}

async function normalizeFile(path, label, totals) {
  const value = await inspect(path, label);
  if (!value.isFile()) fail(`${label} is not a regular file`);
  totals.files += 1;
  totals.bytes += value.size;
  if (totals.files > MAX_PACKAGE_FILES || totals.bytes > MAX_PACKAGE_BYTES) {
    fail("publishable package surface exceeds its normalization bounds");
  }
  await chmod(path, 0o644);
  const finalValue = await inspect(path, label);
  if (!finalValue.isFile() || !modeMatches(finalValue.mode & 0o777, 0o644)) {
    fail(`${label} mode is not deterministic`);
  }
}

async function normalizeOptionalFile(path, label, totals) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail(`${label} metadata is unavailable`);
  }
  await normalizeFile(path, label, totals);
}

async function normalizeDirectory(path, label, totals) {
  const value = await inspect(path, label);
  if (!value.isDirectory()) fail(`${label} is not a real directory`);
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const child = join(path, entry.name);
    const childLabel = `${label} entry`;
    if (entry.isSymbolicLink()) fail(`${childLabel} is a symbolic link`);
    if (entry.isDirectory()) {
      await normalizeDirectory(child, childLabel, totals);
    } else if (entry.isFile()) {
      await normalizeFile(child, childLabel, totals);
    } else {
      fail(`${childLabel} is not a regular file or directory`);
    }
  }
  await chmod(path, 0o755);
  const finalValue = await inspect(path, label);
  if (!finalValue.isDirectory() || !modeMatches(finalValue.mode & 0o777, 0o755)) {
    fail(`${label} mode is not deterministic`);
  }
}

/**
 * Compare a real file mode against the intended POSIX mode.
 *
 * Windows filesystems (NTFS/FAT) have no executable bit and map the
 * read-only attribute to the write bits only, so a freshly written file or
 * directory is always reported as 0o666 no matter what chmod requested; the
 * 0o444 read bits and the 0o111 execute bits are not representable. The
 * strict byte-for-byte comparison is therefore reserved for POSIX; on
 * Windows we only assert the read bits are present (the entry was not
 * accidentally locked down).
 */
function modeMatches(actual, intended) {
  if (process.platform === "win32") {
    return (actual & 0o444) === 0o444;
  }
  return actual === intended;
}

async function normalizePackageModes() {
  if (process.argv.length !== 2) {
    fail("this command does not accept arguments or path overrides");
  }
  const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const totals = { files: 0, bytes: 0 };
  await normalizeFile(join(root, "README.md"), "README", totals);
  await normalizeFile(join(root, "package.json"), "package manifest", totals);
  for (const path of OPTIONAL_LEGAL_FILES) {
    await normalizeOptionalFile(join(root, path), `optional legal file ${path}`, totals);
  }
  await normalizeDirectory(join(root, "dist", "src"), "ES module output", totals);
  await normalizeDirectory(join(root, "dist", "cjs"), "CommonJS output", totals);
}

try {
  await normalizePackageModes();
} catch (error) {
  const message = error instanceof PackageModeError
    ? error.message
    : "unexpected package-mode normalization failure";
  process.stderr.write(`open-rfc package-mode normalization failed: ${message}\n`);
  process.exitCode = 1;
}
