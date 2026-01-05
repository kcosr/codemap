import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import micromatch from "micromatch";

export type DiscoveryOptions = {
  repoRoot: string;
  patterns?: string[];
  ignore?: string[];
};

const MM_OPTS = { dot: true } as const;

export function discoverFiles(opts: DiscoveryOptions): string[] {
  const { repoRoot, patterns = [], ignore = [] } = opts;

  let files = discoverAllFiles(repoRoot);

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

function discoverAllFiles(repoRoot: string): string[] {
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], {
      stdio: "ignore",
    });
    const out = execFileSync(
      "git",
      ["-C", repoRoot, "ls-files", "-z", "-co", "--exclude-standard"],
      { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.toString("utf-8").split("\0").filter(Boolean);
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
