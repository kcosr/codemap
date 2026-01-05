import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type TsConfig = {
  configPath: string;
  configDir: string;
  options: ts.CompilerOptions;
  baseUrl?: string;
  paths?: Record<string, string[]>;
};

export type TsResolver = {
  resolveModule: (
    specifier: string,
    importerAbsPath: string,
  ) => ts.ResolvedModuleFull | undefined;
};

export function loadTsConfig(configPath: string): TsConfig | null {
  if (!fs.existsSync(configPath)) return null;

  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return null;

  const configDir = path.dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    configDir,
    undefined,
    configPath,
  );

  const options = parsed.options;
  const baseUrl = options.baseUrl
    ? path.isAbsolute(options.baseUrl)
      ? options.baseUrl
      : path.resolve(configDir, options.baseUrl)
    : undefined;

  return {
    configPath,
    configDir,
    options,
    baseUrl,
    paths: options.paths ?? undefined,
  };
}

export function findNearestTsConfigPath(
  repoRoot: string,
  startDir: string,
  cache: Map<string, string | null>,
): string | null {
  const root = path.resolve(repoRoot);
  let current = path.resolve(startDir);
  const visited: string[] = [];

  while (true) {
    const cached = cache.get(current);
    if (cached !== undefined) {
      for (const dir of visited) cache.set(dir, cached);
      return cached;
    }

    visited.push(current);

    const tsconfig = path.join(current, "tsconfig.json");
    if (fs.existsSync(tsconfig)) {
      for (const dir of visited) cache.set(dir, tsconfig);
      return tsconfig;
    }

    const jsconfig = path.join(current, "jsconfig.json");
    if (fs.existsSync(jsconfig)) {
      for (const dir of visited) cache.set(dir, jsconfig);
      return jsconfig;
    }

    if (current === root) {
      for (const dir of visited) cache.set(dir, null);
      return null;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      for (const dir of visited) cache.set(dir, null);
      return null;
    }

    current = parent;
  }
}

export function createTsResolver(config: TsConfig): TsResolver {
  const getCanonical = ts.sys.useCaseSensitiveFileNames
    ? (fileName: string) => fileName
    : (fileName: string) => fileName.toLowerCase();
  const cache = ts.createModuleResolutionCache(
    config.configDir,
    getCanonical,
    config.options,
  );

  const host: ts.ModuleResolutionHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    realpath: ts.sys.realpath,
    getCurrentDirectory: () => config.configDir,
    getDirectories: ts.sys.getDirectories,
  };

  return {
    resolveModule(specifier, importerAbsPath) {
      const result = ts.resolveModuleName(
        specifier,
        importerAbsPath,
        config.options,
        host,
        cache,
      );
      return result.resolvedModule ?? undefined;
    },
  };
}
