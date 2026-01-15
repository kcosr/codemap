import fs from "node:fs";
import path from "node:path";
import type { ResolvedImport } from "../types.js";
import type { IncludeSpec } from "./extract-includes.js";

export type CppResolverContext = {
  repoRoot: string;
  fileIndex?: Set<string>;
  includePaths?: string[];
};

export function createCppResolverContext(
  repoRoot: string,
  fileIndex?: Set<string>,
  includePaths?: string[],
): CppResolverContext {
  return { repoRoot, fileIndex, includePaths };
}

function normalizeIncludePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function fileExists(ctx: CppResolverContext, repoPath: string): boolean {
  if (ctx.fileIndex) {
    return ctx.fileIndex.has(repoPath);
  }
  return fs.existsSync(path.join(ctx.repoRoot, repoPath));
}

function resolveLocalInclude(
  importerPath: string,
  source: string,
  ctx: CppResolverContext,
): string | null {
  const normalized = normalizeIncludePath(source);
  const baseDir = path.posix.dirname(importerPath);
  const candidate = path.posix.normalize(path.posix.join(baseDir, normalized));
  if (fileExists(ctx, candidate)) return candidate;

  if (ctx.includePaths) {
    for (const includePath of ctx.includePaths) {
      const normalizedInclude = normalizeIncludePath(includePath);
      const resolved = path.posix.normalize(
        path.posix.join(normalizedInclude, normalized),
      );
      if (fileExists(ctx, resolved)) return resolved;
    }
  }

  return null;
}

export function resolveIncludes(
  importerPath: string,
  includes: IncludeSpec[],
  ctx: CppResolverContext,
): ResolvedImport[] {
  const results: ResolvedImport[] = [];
  const seen = new Set<string>();

  for (const include of includes) {
    const key = `${include.kind}:${include.source}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const base: ResolvedImport = {
      source: include.source,
      resolvedPath: null,
      importedNames: [],
      kind: "include",
      isTypeOnly: false,
      isExternal: include.kind === "system",
      isBuiltin: include.kind === "system",
    };

    if (include.kind === "system") {
      results.push({
        ...base,
        isExternal: true,
        isBuiltin: true,
        packageName: include.source,
        resolutionMethod: "include",
      });
      continue;
    }

    const resolved = resolveLocalInclude(importerPath, include.source, ctx);
    if (resolved) {
      results.push({
        ...base,
        resolvedPath: resolved,
        resolutionMethod: "relative",
      });
      continue;
    }

    results.push({
      ...base,
      unresolvedReason: "not_found",
      resolutionMethod: "relative",
    });
  }

  return results;
}
