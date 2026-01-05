import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Language, ResolvedImport, SymbolKind } from "../types.js";
import { migrate } from "./schema.js";
import {
  getFileAnnotation,
  setFileAnnotation,
  removeFileAnnotation,
  listFileAnnotations,
  getSymbolAnnotation,
  setSymbolAnnotation,
  removeSymbolAnnotation,
  listSymbolAnnotations,
  getSymbolAnnotationMap,
  countOrphanedAnnotations,
  pruneOrphanedAnnotations,
} from "./annotations.js";
import {
  insertResolvedImports,
  getResolvedImports,
  getDependencies,
  getDependents,
  listExternalPackages,
  type ResolvedImportRow,
} from "./resolved-imports.js";
import {
  insertReferences,
  deleteReferencesFrom,
  getReferenceList,
  listReferenceRows,
  getRefStates,
  upsertRefState,
  deleteRefState,
} from "./references.js";
import type { ReferenceRow, RefStateRow } from "./references.js";
import { ensureMeta, readMeta, setMeta, updateLastUpdated } from "./meta.js";

export const EXTRACTOR_VERSION = "2";
type DB = Database.Database;

export type CachedFile = {
  path: string;
  mtime: number;
  size: number;
  hash: string;
};

export type FileRow = {
  path: string;
  mtime: number;
  size: number;
  hash: string;
  language: Language;
  line_count: number;
  extractor_version: string;
  updated_at: string;
};

export type SymbolRow = {
  path: string;
  name: string;
  kind: SymbolKind;
  signature: string | null;
  start_line: number;
  end_line: number;
  exported: number;
  is_default: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
  parent_name: string | null;
  jsdoc: string | null;
};

export type SymbolRowWithId = SymbolRow & {
  id: number;
};

export type ImportRow = {
  path: string;
  source: string;
};

export type ResolvedImportEntry = ResolvedImportRow;

export type HeadingRow = {
  path: string;
  level: number;
  text: string;
  line: number;
};

export type CodeBlockRow = {
  path: string;
  language: string | null;
  start_line: number;
  end_line: number;
};

export type CacheStats = {
  cachePath: string;
  sizeBytes: number;
  meta: {
    createdAt: string | null;
    lastUpdatedAt: string | null;
    extractorVersion: string | null;
  };
  files: {
    total: number;
    byLanguage: Record<string, number>;
  };
  symbols: {
    total: number;
    byKind: Record<string, number>;
  };
  annotations: {
    file: number;
    symbol: number;
    orphaned: number;
    orphanedFile: number;
    orphanedSymbol: number;
  };
};

export class CacheDB {
  private db: DB;
  private cachePath: string;

  constructor(db: DB, cachePath: string) {
    this.db = db;
    this.cachePath = cachePath;
  }

  get path(): string {
    return this.cachePath;
  }

  close(): void {
    this.db.close();
  }

  transaction<T extends (...args: any[]) => any>(fn: T): Database.Transaction<T> {
    return this.db.transaction(fn);
  }

  getCachedFiles(): Map<string, CachedFile> {
    const rows = this.db
      .prepare("SELECT path, mtime, size, hash FROM files")
      .all() as CachedFile[];
    const map = new Map<string, CachedFile>();
    for (const row of rows) {
      map.set(row.path, row);
    }
    return map;
  }

  getFile(path: string): FileRow | undefined {
    return this.db
      .prepare(
        "SELECT path, mtime, size, hash, language, line_count, extractor_version, updated_at FROM files WHERE path = ?",
      )
      .get(path) as FileRow | undefined;
  }

  insertFile(file: FileRow): void {
    this.db
      .prepare(
        "INSERT INTO files (path, mtime, size, hash, language, line_count, extractor_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        file.path,
        file.mtime,
        file.size,
        file.hash,
        file.language,
        file.line_count,
        file.extractor_version,
        file.updated_at,
      );
  }

  touchFile(path: string, mtime: number, size: number): void {
    this.db
      .prepare("UPDATE files SET mtime = ?, size = ?, updated_at = ? WHERE path = ?")
      .run(mtime, size, new Date().toISOString(), path);
  }

  deleteFile(path: string): void {
    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
  }

  clearFiles(): void {
    this.db.prepare("DELETE FROM files").run();
  }

  insertSymbols(path: string, symbols: SymbolRow[]): void {
    if (symbols.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT INTO symbols (path, name, kind, signature, start_line, end_line, exported, is_default, is_async, is_static, is_abstract, parent_name, jsdoc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const sym of symbols) {
      stmt.run(
        path,
        sym.name,
        sym.kind,
        sym.signature,
        sym.start_line,
        sym.end_line,
        sym.exported,
        sym.is_default,
        sym.is_async,
        sym.is_static,
        sym.is_abstract,
        sym.parent_name,
        sym.jsdoc,
      );
    }
  }

  insertImports(path: string, imports: ImportRow[]): void {
    if (imports.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO imports (path, source) VALUES (?, ?)",
    );
    for (const imp of imports) {
      stmt.run(path, imp.source);
    }
  }

  insertResolvedImports(path: string, imports: ResolvedImport[]): void {
    insertResolvedImports(this.db, path, imports);
  }

  insertHeadings(path: string, headings: HeadingRow[]): void {
    if (headings.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT INTO headings (path, level, text, line) VALUES (?, ?, ?, ?)",
    );
    for (const h of headings) {
      stmt.run(path, h.level, h.text, h.line);
    }
  }

  insertCodeBlocks(path: string, blocks: CodeBlockRow[]): void {
    if (blocks.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT INTO code_blocks (path, language, start_line, end_line) VALUES (?, ?, ?, ?)",
    );
    for (const b of blocks) {
      stmt.run(path, b.language, b.start_line, b.end_line);
    }
  }

  getSymbols(path: string): SymbolRowWithId[] {
    return this.db
      .prepare(
        "SELECT id, path, name, kind, signature, start_line, end_line, exported, is_default, is_async, is_static, is_abstract, parent_name, jsdoc FROM symbols WHERE path = ? ORDER BY start_line",
      )
      .all(path) as SymbolRowWithId[];
  }

  getSymbolById(id: number): SymbolRowWithId | undefined {
    return this.db
      .prepare(
        "SELECT id, path, name, kind, signature, start_line, end_line, exported, is_default, is_async, is_static, is_abstract, parent_name, jsdoc FROM symbols WHERE id = ?",
      )
      .get(id) as SymbolRowWithId | undefined;
  }

  findSymbolsByName(name: string): SymbolRowWithId[] {
    return this.db
      .prepare(
        "SELECT id, path, name, kind, signature, start_line, end_line, exported, is_default, is_async, is_static, is_abstract, parent_name, jsdoc FROM symbols WHERE name = ? ORDER BY path, start_line",
      )
      .all(name) as SymbolRowWithId[];
  }

  findSymbols(
    path: string | null,
    name: string,
    kind?: string | null,
    parentName?: string | null,
  ): SymbolRowWithId[] {
    const clauses: string[] = ["name = ?"];
    const params: Array<string | null> = [name];
    if (path) {
      clauses.push("path = ?");
      params.push(path);
    }
    if (kind) {
      clauses.push("kind = ?");
      params.push(kind);
    }
    if (parentName !== undefined && parentName !== null) {
      clauses.push("parent_name = ?");
      params.push(parentName);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT id, path, name, kind, signature, start_line, end_line, exported, is_default, is_async, is_static, is_abstract, parent_name, jsdoc FROM symbols ${where} ORDER BY path, start_line`,
      )
      .all(...params) as SymbolRowWithId[];
  }

  getImports(path: string): string[] {
    const rows = this.db
      .prepare("SELECT source FROM imports WHERE path = ? ORDER BY source")
      .all(path) as Array<{ source: string }>;
    return rows.map((row) => row.source);
  }

  getResolvedImports(path: string): ResolvedImportEntry[] {
    return getResolvedImports(this.db, path);
  }

  getDependencies(path: string): string[] {
    return getDependencies(this.db, path);
  }

  getDependents(path: string): string[] {
    return getDependents(this.db, path);
  }

  listExternalPackages(): string[] {
    return listExternalPackages(this.db);
  }

  getHeadings(path: string): HeadingRow[] {
    return this.db
      .prepare(
        "SELECT path, level, text, line FROM headings WHERE path = ? ORDER BY line",
      )
      .all(path) as HeadingRow[];
  }

  getCodeBlocks(path: string): CodeBlockRow[] {
    return this.db
      .prepare(
        "SELECT path, language, start_line, end_line FROM code_blocks WHERE path = ? ORDER BY start_line",
      )
      .all(path) as CodeBlockRow[];
  }

  insertReferences(refs: ReferenceRow[]): void {
    insertReferences(this.db, refs);
  }

  deleteReferencesFrom(path: string): void {
    deleteReferencesFrom(this.db, path);
  }

  getReferenceList(
    direction: Parameters<typeof getReferenceList>[1]["direction"],
    key: Parameters<typeof getReferenceList>[1]["key"],
    refKinds?: Parameters<typeof getReferenceList>[1]["refKinds"],
    maxItems?: Parameters<typeof getReferenceList>[1]["maxItems"],
  ): ReturnType<typeof getReferenceList> {
    return getReferenceList(this.db, { direction, key, refKinds, maxItems });
  }

  listReferenceRows(
    direction: Parameters<typeof listReferenceRows>[1]["direction"],
    key: Parameters<typeof listReferenceRows>[1]["key"],
    refKinds?: Parameters<typeof listReferenceRows>[1]["refKinds"],
  ): ReturnType<typeof listReferenceRows> {
    return listReferenceRows(this.db, { direction, key, refKinds });
  }

  getRefStates(): Map<string, RefStateRow> {
    return getRefStates(this.db);
  }

  upsertRefState(path: string, refsHash: string, projectHash: string | null): void {
    upsertRefState(this.db, path, refsHash, projectHash);
  }

  deleteRefState(path: string): void {
    deleteRefState(this.db, path);
  }

  getMeta(): { createdAt: string | null; lastUpdatedAt: string | null; extractorVersion: string | null } {
    return readMeta(this.db);
  }

  ensureExtractorVersion(version: string): boolean {
    const meta = ensureMeta(this.db, version);
    if (meta.extractorVersion !== version) {
      this.clearFiles();
      setMeta(this.db, "extractor_version", version);
      return true;
    }
    return false;
  }

  updateLastUpdated(): string {
    return updateLastUpdated(this.db);
  }

  getFileAnnotation(path: string): string | null {
    return getFileAnnotation(this.db, path);
  }

  setFileAnnotation(path: string, note: string): void {
    setFileAnnotation(this.db, path, note);
  }

  removeFileAnnotation(path: string): number {
    return removeFileAnnotation(this.db, path);
  }

  listFileAnnotations(path?: string): ReturnType<typeof listFileAnnotations> {
    return listFileAnnotations(this.db, path);
  }

  getSymbolAnnotation(
    key: Parameters<typeof getSymbolAnnotation>[1],
  ): string | null {
    return getSymbolAnnotation(this.db, key);
  }

  setSymbolAnnotation(
    key: Parameters<typeof setSymbolAnnotation>[1],
    note: string,
  ): void {
    setSymbolAnnotation(this.db, key, note);
  }

  removeSymbolAnnotation(key: Parameters<typeof removeSymbolAnnotation>[1]): number {
    return removeSymbolAnnotation(this.db, key);
  }

  listSymbolAnnotations(path?: string): ReturnType<typeof listSymbolAnnotations> {
    return listSymbolAnnotations(this.db, path);
  }

  getSymbolAnnotationMap(path: string): Map<string, string> {
    return getSymbolAnnotationMap(this.db, path);
  }

  countOrphanedAnnotations(): { file: number; symbol: number } {
    return countOrphanedAnnotations(this.db);
  }

  pruneOrphanedAnnotations(): { file: number; symbol: number } {
    return pruneOrphanedAnnotations(this.db);
  }

  getTotalCodebaseBytes(): number {
    const row = this.db
      .prepare("SELECT SUM(size) as total FROM files")
      .get() as { total: number | null } | undefined;
    return row?.total ?? 0;
  }

  getCacheStats(): CacheStats {
    const meta = this.getMeta();
    const stat = fs.existsSync(this.cachePath)
      ? fs.statSync(this.cachePath)
      : null;
    const sizeBytes = stat?.size ?? 0;

    const fileTotal = (this.db
      .prepare("SELECT COUNT(*) as count FROM files")
      .get() as { count: number } | undefined)?.count ?? 0;
    const fileRows = this.db
      .prepare("SELECT language, COUNT(*) as count FROM files GROUP BY language")
      .all() as Array<{ language: string; count: number }>;
    const byLanguage: Record<string, number> = {};
    for (const row of fileRows) {
      byLanguage[row.language] = row.count;
    }

    const symbolTotal = (this.db
      .prepare("SELECT COUNT(*) as count FROM symbols")
      .get() as { count: number } | undefined)?.count ?? 0;
    const symbolRows = this.db
      .prepare("SELECT kind, COUNT(*) as count FROM symbols GROUP BY kind")
      .all() as Array<{ kind: string; count: number }>;
    const byKind: Record<string, number> = {};
    for (const row of symbolRows) {
      byKind[row.kind] = row.count;
    }

    const annotationFileCount = (this.db
      .prepare("SELECT COUNT(*) as count FROM file_annotations")
      .get() as { count: number } | undefined)?.count ?? 0;
    const annotationSymbolCount = (this.db
      .prepare("SELECT COUNT(*) as count FROM symbol_annotations")
      .get() as { count: number } | undefined)?.count ?? 0;
    const orphaned = this.countOrphanedAnnotations();

    return {
      cachePath: this.cachePath,
      sizeBytes,
      meta,
      files: {
        total: fileTotal,
        byLanguage,
      },
      symbols: {
        total: symbolTotal,
        byKind,
      },
      annotations: {
        file: annotationFileCount,
        symbol: annotationSymbolCount,
        orphaned: orphaned.file + orphaned.symbol,
        orphanedFile: orphaned.file,
        orphanedSymbol: orphaned.symbol,
      },
    };
  }
}

function applyPragmas(db: DB): void {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("temp_store = MEMORY");
}

export function openCache(repoRoot: string): CacheDB {
  const cacheDir = path.join(repoRoot, ".codemap");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, "cache.db");

  const db = new Database(cachePath);
  applyPragmas(db);
  migrate(db);
  ensureMeta(db, EXTRACTOR_VERSION);

  return new CacheDB(db, cachePath);
}
