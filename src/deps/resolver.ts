import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import type { ImportSpec, ResolvedImport, ResolutionMethod } from "../types.js";
import {
  createTsResolver,
  findNearestTsConfigPath,
  loadTsConfig,
  type TsConfig,
  type TsResolver,
} from "./ts-resolver.js";

const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".d.ts",
];

const INDEX_FILES = [
  "index.ts",
  "index.tsx",
  "index.mts",
  "index.cts",
  "index.js",
  "index.jsx",
  "index.mjs",
  "index.cjs",
  "index.d.ts",
];

const EXTENSION_SET = new Set(EXTENSIONS);
const BUILTIN_SET = new Set(builtinModules);

export type ResolverContext = {
  repoRoot: string;
  fileIndex?: Set<string>;
  tsconfigPath?: string | null;
  useTsconfig: boolean;
  tsconfigCache: Map<string, TsConfig | null>;
  tsconfigPathCache: Map<string, string | null>;
  tsResolverCache: Map<string, TsResolver>;
};

export function createResolverContext(
  repoRoot: string,
  fileIndex?: Set<string>,
  opts?: { tsconfigPath?: string | null; useTsconfig?: boolean },
): ResolverContext {
  const tsconfigPath = opts?.tsconfigPath
    ? path.isAbsolute(opts.tsconfigPath)
      ? opts.tsconfigPath
      : path.resolve(repoRoot, opts.tsconfigPath)
    : null;

  return {
    repoRoot,
    fileIndex,
    tsconfigPath,
    useTsconfig: opts?.useTsconfig !== false,
    tsconfigCache: new Map(),
    tsconfigPathCache: new Map(),
    tsResolverCache: new Map(),
  };
}

function isBuiltinModule(source: string): boolean {
  if (BUILTIN_SET.has(source)) return true;
  if (source.startsWith("node:")) {
    return BUILTIN_SET.has(source.slice("node:".length));
  }
  return false;
}

function getPackageName(source: string): string {
  if (source.startsWith("@")) {
    const [scope, name] = source.split("/");
    return scope && name ? `${scope}/${name}` : source;
  }
  return source.split("/")[0];
}

function isRelativeSource(source: string): boolean {
  return source.startsWith(".");
}

function isAbsoluteSource(source: string): boolean {
  return source.startsWith("/");
}

function isBareSource(source: string): boolean {
  return !isRelativeSource(source) && !isAbsoluteSource(source);
}

function toRepoPath(repoRoot: string, absPath: string): string | null {
  const rel = path.relative(repoRoot, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function isNodeModulesPath(filePath: string): boolean {
  return (
    filePath.includes(`${path.sep}node_modules${path.sep}`) ||
    filePath.includes("/node_modules/") ||
    filePath.includes("\\node_modules\\")
  );
}

function fileExistsRepo(ctx: ResolverContext, repoPath: string): boolean {
  if (repoPath.startsWith("..") || path.posix.isAbsolute(repoPath)) return false;
  if (ctx.fileIndex?.has(repoPath)) return true;
  return fs.existsSync(path.join(ctx.repoRoot, repoPath));
}

function resolveCandidate(ctx: ResolverContext, candidate: string): string | null {
  let normalized = path.posix.normalize(candidate);
  if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (!normalized || normalized === ".") return null;
  if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) return null;

  const tryPaths: string[] = [];
  const ext = path.posix.extname(normalized);
  tryPaths.push(normalized);

  if (!EXTENSION_SET.has(ext)) {
    for (const extension of EXTENSIONS) {
      tryPaths.push(normalized + extension);
    }
  }

  for (const indexFile of INDEX_FILES) {
    tryPaths.push(path.posix.join(normalized, indexFile));
  }

  for (const p of tryPaths) {
    if (fileExistsRepo(ctx, p)) return p;
  }

  return null;
}

function resolveRelative(
  ctx: ResolverContext,
  importerPath: string,
  source: string,
): { resolved: string | null; method?: ResolutionMethod } {
  const importerDir = path.posix.dirname(importerPath);
  const candidate = path.posix.normalize(path.posix.join(importerDir, source));
  const resolved = resolveCandidate(ctx, candidate);
  return { resolved, method: resolved ? "relative" : undefined };
}

function matchPattern(pattern: string, source: string): string[] | null {
  if (!pattern.includes("*")) {
    return pattern === source ? [] : null;
  }

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*/g, "(.*)")}$`);
  const match = source.match(regex);
  if (!match) return null;
  return match.slice(1);
}

function applyPattern(target: string, matches: string[]): string {
  let out = target;
  for (const match of matches) {
    out = out.replace(/\*/, match);
  }
  return out;
}

function resolveWithPaths(
  ctx: ResolverContext,
  source: string,
  config: TsConfig,
): { resolved: string | null; method?: ResolutionMethod } {
  if (!config.paths) return { resolved: null };
  const baseDir = config.baseUrl ?? config.configDir;

  for (const [pattern, targets] of Object.entries(config.paths)) {
    const matches = matchPattern(pattern, source);
    if (!matches) continue;
    for (const target of targets) {
      const substituted = applyPattern(target, matches);
      const abs = path.resolve(baseDir, substituted);
      const repoPath = toRepoPath(ctx.repoRoot, abs);
      if (!repoPath) continue;
      const resolved = resolveCandidate(ctx, repoPath);
      if (resolved) return { resolved, method: "paths" };
    }
  }

  return { resolved: null };
}

function resolveWithBaseUrl(
  ctx: ResolverContext,
  source: string,
  config: TsConfig,
): { resolved: string | null; method?: ResolutionMethod } {
  if (!config.baseUrl) return { resolved: null };
  const abs = path.resolve(config.baseUrl, source);
  const repoPath = toRepoPath(ctx.repoRoot, abs);
  if (!repoPath) return { resolved: null };
  const resolved = resolveCandidate(ctx, repoPath);
  return { resolved, method: resolved ? "baseUrl" : undefined };
}

function getTsConfig(
  ctx: ResolverContext,
  importerAbsPath: string,
): TsConfig | null {
  if (!ctx.useTsconfig) return null;

  if (ctx.tsconfigPath) {
    const cached = ctx.tsconfigCache.get(ctx.tsconfigPath);
    if (cached !== undefined) return cached;
    const loaded = loadTsConfig(ctx.tsconfigPath);
    ctx.tsconfigCache.set(ctx.tsconfigPath, loaded);
    return loaded;
  }

  const configPath = findNearestTsConfigPath(
    ctx.repoRoot,
    path.dirname(importerAbsPath),
    ctx.tsconfigPathCache,
  );
  if (!configPath) return null;

  const cached = ctx.tsconfigCache.get(configPath);
  if (cached !== undefined) return cached;

  const loaded = loadTsConfig(configPath);
  ctx.tsconfigCache.set(configPath, loaded);
  return loaded;
}

function getTsResolver(ctx: ResolverContext, config: TsConfig): TsResolver {
  const cached = ctx.tsResolverCache.get(config.configPath);
  if (cached) return cached;
  const resolver = createTsResolver(config);
  ctx.tsResolverCache.set(config.configPath, resolver);
  return resolver;
}

function resolveWithTs(
  ctx: ResolverContext,
  source: string,
  importerAbsPath: string,
  config: TsConfig,
): {
  resolvedPath: string | null;
  isExternal: boolean;
  resolutionMethod: ResolutionMethod;
} | null {
  const resolver = getTsResolver(ctx, config);
  const resolved = resolver.resolveModule(source, importerAbsPath);
  if (!resolved) return null;

  const resolvedFile = resolved.resolvedFileName;
  if (isNodeModulesPath(resolvedFile)) {
    return {
      resolvedPath: null,
      isExternal: true,
      resolutionMethod: "ts",
    };
  }

  const repoPath = toRepoPath(ctx.repoRoot, resolvedFile);
  if (repoPath) {
    return {
      resolvedPath: repoPath,
      isExternal: false,
      resolutionMethod: "ts",
    };
  }

  return {
    resolvedPath: null,
    isExternal: true,
    resolutionMethod: "ts",
  };
}

function resolveOneImport(
  importerPath: string,
  importerAbsPath: string,
  spec: ImportSpec,
  ctx: ResolverContext,
  config: TsConfig | null,
): ResolvedImport {
  const base: ResolvedImport = {
    source: spec.source,
    resolvedPath: null,
    importedNames: spec.importedNames,
    kind: spec.kind,
    isTypeOnly: spec.isTypeOnly,
    isExternal: false,
    isBuiltin: false,
    span: spec.span,
  };

  if (spec.isLiteral === false) {
    return {
      ...base,
      unresolvedReason: "non_literal",
    };
  }

  if (isAbsoluteSource(spec.source)) {
    const resolved = resolveCandidate(ctx, spec.source.slice(1));
    if (resolved) {
      return {
        ...base,
        resolvedPath: resolved,
        resolutionMethod: "relative",
      };
    }
  }

  if (isRelativeSource(spec.source)) {
    const result = resolveRelative(ctx, importerPath, spec.source);
    if (result.resolved) {
      return {
        ...base,
        resolvedPath: result.resolved,
        resolutionMethod: result.method,
      };
    }
  }

  if (config) {
    const pathsResult = resolveWithPaths(ctx, spec.source, config);
    if (pathsResult.resolved) {
      return {
        ...base,
        resolvedPath: pathsResult.resolved,
        resolutionMethod: pathsResult.method,
      };
    }

    const baseUrlResult = resolveWithBaseUrl(ctx, spec.source, config);
    if (baseUrlResult.resolved) {
      return {
        ...base,
        resolvedPath: baseUrlResult.resolved,
        resolutionMethod: baseUrlResult.method,
      };
    }

    const tsResult = resolveWithTs(ctx, spec.source, importerAbsPath, config);
    if (tsResult) {
      if (tsResult.isExternal) {
        const builtin = isBuiltinModule(spec.source);
        return {
          ...base,
          isExternal: true,
          isBuiltin: builtin,
          packageName: builtin
            ? spec.source.startsWith("node:")
              ? spec.source.slice("node:".length)
              : spec.source
            : getPackageName(spec.source),
          resolutionMethod: tsResult.resolutionMethod,
        };
      }
      return {
        ...base,
        resolvedPath: tsResult.resolvedPath,
        resolutionMethod: tsResult.resolutionMethod,
      };
    }
  }

  if (isBuiltinModule(spec.source)) {
    return {
      ...base,
      isExternal: true,
      isBuiltin: true,
      packageName: spec.source.startsWith("node:")
        ? spec.source.slice("node:".length)
        : spec.source,
    };
  }

  if (isBareSource(spec.source)) {
    return {
      ...base,
      isExternal: true,
      packageName: getPackageName(spec.source),
    };
  }

  return {
    ...base,
    unresolvedReason: "not_found",
  };
}

export function resolveImports(
  importerPath: string,
  specs: ImportSpec[],
  ctx: ResolverContext,
): ResolvedImport[] {
  const importerAbsPath = path.resolve(ctx.repoRoot, importerPath);
  const config = getTsConfig(ctx, importerAbsPath);
  return specs.map((spec) =>
    resolveOneImport(importerPath, importerAbsPath, spec, ctx, config),
  );
}
