import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  detectChanges,
  statDiscoveredFiles,
  computeFileHash,
} from "../src/cache/changes.js";
import type { CachedFile } from "../src/cache/db.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codemap-changes-"));
}

describe("detectChanges", () => {
  it("detects added files", () => {
    const dir = createTempDir();
    const filePath = path.join(dir, "new.txt");
    fs.writeFileSync(filePath, "hello");

    const discovered = statDiscoveredFiles(dir, ["new.txt"]);
    const cached = new Map<string, CachedFile>();

    const result = detectChanges(discovered, cached);

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toEqual({ path: "new.txt", status: "added" });
    expect(result.touches).toHaveLength(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects deleted files", () => {
    const dir = createTempDir();
    const cached = new Map<string, CachedFile>([
      [
        "missing.txt",
        { path: "missing.txt", mtime: 1, size: 1, hash: "abc" },
      ],
    ]);

    const result = detectChanges([], cached);

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toEqual({
      path: "missing.txt",
      status: "deleted",
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects modified files by hash", () => {
    const dir = createTempDir();
    const relPath = "change.txt";
    const filePath = path.join(dir, relPath);

    fs.writeFileSync(filePath, "before");
    const initial = statDiscoveredFiles(dir, [relPath])[0];
    const cached = new Map<string, CachedFile>([
      [
        relPath,
        {
          path: relPath,
          mtime: initial.mtime,
          size: initial.size,
          hash: computeFileHash(initial.fullPath),
        },
      ],
    ]);

    fs.writeFileSync(filePath, "after");
    const discovered = statDiscoveredFiles(dir, [relPath]);

    const result = detectChanges(discovered, cached);

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toEqual({
      path: relPath,
      status: "modified",
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records touches when content is unchanged", () => {
    const dir = createTempDir();
    const relPath = "touch.txt";
    const filePath = path.join(dir, relPath);

    fs.writeFileSync(filePath, "same");
    const initial = statDiscoveredFiles(dir, [relPath])[0];
    const cached = new Map<string, CachedFile>([
      [
        relPath,
        {
          path: relPath,
          mtime: initial.mtime,
          size: initial.size,
          hash: computeFileHash(initial.fullPath),
        },
      ],
    ]);

    const newTime = new Date(Date.now() + 2000);
    fs.utimesSync(filePath, newTime, newTime);
    const discovered = statDiscoveredFiles(dir, [relPath]);

    const result = detectChanges(discovered, cached);

    expect(result.changes).toHaveLength(0);
    expect(result.touches).toHaveLength(1);
    expect(result.touches[0].path).toBe(relPath);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
