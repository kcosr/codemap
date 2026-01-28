import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { discoverFiles } from "../src/fileDiscovery.js";

function createGitProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-discovery-"));
  execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });

  fs.writeFileSync(path.join(dir, ".gitignore"), "nodejs-sdk/\n");
  fs.mkdirSync(path.join(dir, "nodejs-sdk", "models"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "nodejs-sdk", "models", "Example.ts"),
    "export const example = true;\n",
  );

  return dir;
}

describe("discoverFiles", () => {
  it("can include ignored paths when requested", () => {
    const dir = createGitProject();

    const withoutIgnored = discoverFiles({
      repoRoot: dir,
      patterns: ["nodejs-sdk/models/**"],
    });
    expect(withoutIgnored).toEqual([]);

    const withIgnored = discoverFiles({
      repoRoot: dir,
      patterns: ["nodejs-sdk/models/**"],
      includeIgnored: ["nodejs-sdk/models/**"],
    });
    expect(withIgnored).toEqual(["nodejs-sdk/models/Example.ts"]);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
