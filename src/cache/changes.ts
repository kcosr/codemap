import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CachedFile } from "./db.js";

export type DiscoveredFile = {
  path: string;
  fullPath: string;
  mtime: number;
  size: number;
};

export type FileChange = {
  path: string;
  status: "added" | "modified" | "deleted";
};

export type FileTouch = {
  path: string;
  mtime: number;
  size: number;
};

export function statDiscoveredFiles(
  repoRoot: string,
  files: string[],
): DiscoveredFile[] {
  const discovered: DiscoveredFile[] = [];
  for (const relPath of files) {
    const fullPath = path.join(repoRoot, relPath);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      discovered.push({
        path: relPath,
        fullPath,
        mtime: Math.floor(stat.mtimeMs),
        size: stat.size,
      });
    } catch {
      continue;
    }
  }
  return discovered;
}

export function computeFileHash(fullPath: string): string {
  const buf = fs.readFileSync(fullPath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function detectChanges(
  discovered: DiscoveredFile[],
  cached: Map<string, CachedFile>,
): { changes: FileChange[]; touches: FileTouch[] } {
  const changes: FileChange[] = [];
  const touches: FileTouch[] = [];
  const seen = new Set<string>();

  for (const file of discovered) {
    seen.add(file.path);
    const cachedFile = cached.get(file.path);

    if (!cachedFile) {
      changes.push({ path: file.path, status: "added" });
      continue;
    }

    if (file.mtime === cachedFile.mtime && file.size === cachedFile.size) {
      continue;
    }

    let hash = "";
    try {
      hash = computeFileHash(file.fullPath);
    } catch {
      changes.push({ path: file.path, status: "modified" });
      continue;
    }

    if (hash !== cachedFile.hash) {
      changes.push({ path: file.path, status: "modified" });
    } else {
      touches.push({ path: file.path, mtime: file.mtime, size: file.size });
    }
  }

  for (const cachedPath of cached.keys()) {
    if (!seen.has(cachedPath)) {
      changes.push({ path: cachedPath, status: "deleted" });
    }
  }

  return { changes, touches };
}
