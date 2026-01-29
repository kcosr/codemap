import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import micromatch from "micromatch";

export type DiscoveryOptions = {
  repoRoot: string;
  patterns?: string[];
  ignore?: string[];
  includeIgnored?: string[];
};

const MM_OPTS = { dot: true } as const;

export function discoverFiles(opts: DiscoveryOptions): string[] {
  const { repoRoot, patterns = [], ignore = [], includeIgnored = [] } = opts;

  let files = discoverAllFiles(repoRoot, includeIgnored).map(normalizeRepoPath);

  if (patterns.length > 0) {
    files = files.filter((f) =>
      patterns.some((p) => micromatch.isMatch(f, p, MM_OPTS)),
    );
  }

  if (ignore.length > 0) {
    files = files.filter(
      (f) => !ignore.some((p) => micromatch.isMatch(f, p, MM_OPTS)),
    );
  }

  return files.sort();
}

function normalizeRepoPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function discoverAllFiles(repoRoot: string, includeIgnored: string[]): string[] {
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], {
      stdio: "ignore",
    });
    const out = execFileSync(
      "git",
      ["-C", repoRoot, "ls-files", "-z", "-co", "--exclude-standard"],
      { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
    );
    const files = out.toString("utf-8").split("\0").filter(Boolean);
    if (includeIgnored.length === 0) {
      return files;
    }
    try {
      const includeAllIgnored = includeIgnored.some(
        (pattern) => pattern === "*" || pattern === "**/*" || pattern === ".",
      );
      const ignoredArgs = [
        "-C",
        repoRoot,
        "ls-files",
        "-z",
        "-co",
        "--exclude-standard",
        "--ignored",
      ];
      if (!includeAllIgnored) {
        ignoredArgs.push("--", ...includeIgnored);
      }
      const ignoredOut = execFileSync(
        "git",
        ignoredArgs,
        { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
      );
      const ignored = ignoredOut
        .toString("utf-8")
        .split("\0")
        .filter(Boolean);
      return Array.from(new Set([...files, ...ignored]));
    } catch {
      return files;
    }
  } catch {
    return walkDirectory(repoRoot, repoRoot);
  }
}

function walkDirectory(dir: string, root: string): string[] {
  const results: string[] = [];
  const skip = new Set([".git", ".codemap", "node_modules", "dist", "build"]);

  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;

    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      results.push(...walkDirectory(full, root));
    } else {
      results.push(path.relative(root, full));
    }
  }

  return results;
}
