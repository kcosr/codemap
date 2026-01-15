#!/usr/bin/env node
/**
 * bump-version.mjs
 *
 * Updates the version in package.json.
 *
 * Usage:
 *   node scripts/bump-version.mjs patch     # 1.0.0 -> 1.0.1
 *   node scripts/bump-version.mjs minor     # 1.0.1 -> 1.1.0
 *   node scripts/bump-version.mjs major     # 1.1.0 -> 2.0.0
 *   node scripts/bump-version.mjs 2.0.0     # Set to specific version
 *   node scripts/bump-version.mjs           # Show current version
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const packageJsonPath = join(root, 'package.json');

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    suffix: match[4] || '',
  };
}

function formatVersion(parts) {
  return `${parts.major}.${parts.minor}.${parts.patch}${parts.suffix}`;
}

function updatePackageJson(version) {
  const raw = readFileSync(packageJsonPath, 'utf8');
  const data = JSON.parse(raw);
  if (data.version === version) {
    return false;
  }
  data.version = version;
  writeFileSync(packageJsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return true;
}

function updatePackageLock(version) {
  const lockPath = join(root, 'package-lock.json');
  if (!existsSync(lockPath)) {
    return false;
  }
  const raw = readFileSync(lockPath, 'utf8');
  const lock = JSON.parse(raw);
  let updated = false;

  if (lock.version !== version) {
    lock.version = version;
    updated = true;
  }

  if (lock.packages && lock.packages[''] && lock.packages[''].version !== version) {
    lock.packages[''].version = version;
    updated = true;
  }

  if (updated) {
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  }
  return updated;
}

const currentVersion = readVersion();
const arg = process.argv[2];

if (!arg) {
  console.log(`Current version: ${currentVersion}`);
  process.exit(0);
}

const parts = parseVersion(currentVersion);
if (!parts) {
  console.error(`Current version "${currentVersion}" is not valid semver (X.Y.Z)`);
  process.exit(1);
}

let newVersion;

switch (arg.toLowerCase()) {
  case 'patch':
    parts.patch += 1;
    parts.suffix = '';
    newVersion = formatVersion(parts);
    break;
  case 'minor':
    parts.minor += 1;
    parts.patch = 0;
    parts.suffix = '';
    newVersion = formatVersion(parts);
    break;
  case 'major':
    parts.major += 1;
    parts.minor = 0;
    parts.patch = 0;
    parts.suffix = '';
    newVersion = formatVersion(parts);
    break;
  default:
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(arg)) {
      console.error(
        `Invalid version: "${arg}". Use patch, minor, major, or a semver like 1.2.3`
      );
      process.exit(1);
    }
    newVersion = arg;
}

const pkgUpdated = updatePackageJson(newVersion);
if (pkgUpdated) {
  console.log(`Version updated: ${currentVersion} -> ${newVersion}`);
} else {
  console.log(`Version already at ${newVersion}`);
}

const lockUpdated = updatePackageLock(newVersion);
if (lockUpdated) {
  console.log('Updated package-lock.json.');
}
