import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CacheDB } from "../cache/db.js";
import type { FileChange } from "../cache/changes.js";
import { detectLanguage, canExtractSymbols } from "../languages.js";
import { findNearestTsConfigPath } from "../deps/ts-resolver.js";
import { extractFileReferences, loadProject, SymbolIndex, type ReferenceMode } from "./extractor.js";

type UpdateRefsOptions = {
  repoRoot: string;
  filePaths: string[];
  changes: FileChange[];
  refsMode: ReferenceMode;
  forceRefs?: boolean;
  tsconfigPath?: string;
  useTsconfig?: boolean;
};

export function updateReferences(db: CacheDB, opts: UpdateRefsOptions): void {
  if (!opts.refsMode) return;

  const symbolFiles = opts.filePaths.filter((relPath) =>
    canExtractSymbols(detectLanguage(relPath)),
  );
  if (symbolFiles.length === 0) return;

  const fileSet = new Set(symbolFiles);
  const refStates = db.getRefStates();
  const cachedFiles = db.getCachedFiles();
  const cachedPaths = new Set(cachedFiles.keys());
  const projectHash = computeProjectHash(
    resolveTsconfigPath(opts.repoRoot, opts.tsconfigPath, opts.useTsconfig),
  );

  const changedPaths = opts.changes
    .filter((change) => change.status !== "deleted" && fileSet.has(change.path))
    .map((change) => change.path);
  const deletedPaths = opts.changes
    .filter((change) => change.status === "deleted")
    .map((change) => change.path);

  for (const path of deletedPaths) {
    db.deleteRefState(path);
  }

  const targets = new Set<string>();

  if (opts.forceRefs) {
    for (const path of symbolFiles) targets.add(path);
  } else {
    for (const path of symbolFiles) {
      const cached = cachedFiles.get(path);
      if (!cached) continue;
      const refsHash = buildRefsHash(cached.hash, opts.refsMode, projectHash);
      const state = refStates.get(path);
      if (!state || state.refs_hash !== refsHash || state.project_hash !== projectHash) {
        targets.add(path);
      }
    }
    for (const path of changedPaths) {
      targets.add(path);
    }
  }

  if (targets.size === 0) return;

  const affected = computeAffectedFiles(db, targets);
  const affectedList = [...affected].filter((relPath) => fileSet.has(relPath));
  if (affectedList.length === 0) return;

  const tsconfigPath = resolveTsconfigPath(
    opts.repoRoot,
    opts.tsconfigPath,
    opts.useTsconfig,
  );
  const project = loadProject(opts.repoRoot, symbolFiles, tsconfigPath);
  const symbolIndex = new SymbolIndex(db, opts.repoRoot);

  const clearRefs = db.transaction(() => {
    for (const relPath of affectedList) {
      db.deleteReferencesFrom(relPath);
      db.deleteRefState(relPath);
    }
  });
  clearRefs();

  const insertRefs = db.transaction(() => {
    for (const relPath of affectedList) {
      const sourceFile = getSourceFile(project, opts.repoRoot, relPath);
      if (!sourceFile) continue;
      const refs = extractFileReferences(
        sourceFile,
        relPath,
        opts.repoRoot,
        symbolIndex,
        opts.refsMode,
      );
      const sanitized = sanitizeReferences(refs, cachedPaths);
      if (sanitized.length > 0) {
        db.insertReferences(sanitized);
      }

      const cached = cachedFiles.get(relPath);
      if (!cached) continue;
      const refsHash = buildRefsHash(cached.hash, opts.refsMode, projectHash);
      db.upsertRefState(relPath, refsHash, projectHash);
    }
  });
  insertRefs();
}

function sanitizeReferences(
  refs: ReturnType<typeof extractFileReferences>,
  cachedPaths: Set<string>,
): ReturnType<typeof extractFileReferences> {
  if (refs.length === 0) return refs;
  let changed = false;
  const next = refs.map((ref) => {
    if (ref.to_path && !cachedPaths.has(ref.to_path)) {
      changed = true;
      return {
        ...ref,
        to_path: null,
        to_symbol_id: null,
      };
    }
    return ref;
  });
  return changed ? next : refs;
}

function computeAffectedFiles(db: CacheDB, roots: Set<string>): Set<string> {
  const affected = new Set<string>(roots);
  const queue = [...roots];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    const dependents = db.getDependents(current);
    for (const dep of dependents) {
      if (!affected.has(dep)) {
        affected.add(dep);
        queue.push(dep);
      }
    }
  }

  return affected;
}

function getSourceFile(
  project: ReturnType<typeof loadProject>,
  repoRoot: string,
  relPath: string,
) {
  const absPath = path.join(repoRoot, relPath);
  return (
    project.getSourceFile(absPath) ??
    project.getSourceFile(relPath) ??
    project.addSourceFileAtPathIfExists(absPath)
  );
}

function computeProjectHash(tsconfigPath: string | null): string | null {
  if (!tsconfigPath) return null;
  try {
    const content = fs.readFileSync(tsconfigPath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

function buildRefsHash(
  fileHash: string,
  refsMode: ReferenceMode,
  projectHash: string | null,
): string {
  return `${fileHash}:${refsMode}:${projectHash ?? ""}`;
}

function resolveTsconfigPath(
  repoRoot: string,
  tsconfigPath?: string,
  useTsconfig?: boolean,
): string | null {
  if (useTsconfig === false) return null;
  if (tsconfigPath) return tsconfigPath;
  return findNearestTsConfigPath(repoRoot, repoRoot, new Map()) ?? null;
}
