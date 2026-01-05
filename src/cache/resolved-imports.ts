import type Database from "better-sqlite3";
import type { ImportKind, ResolutionMethod, ResolvedImport } from "../types.js";

type DB = Database.Database;

export type ResolvedImportRow = {
  importer_path: string;
  source: string;
  resolved_path: string | null;
  imported_names: string[];
  kind: ImportKind;
  is_type_only: number;
  is_external: number;
  is_builtin: number;
  package_name: string | null;
  resolution_method: ResolutionMethod | null;
  unresolved_reason: string | null;
  span_start: number | null;
  span_end: number | null;
};

function parseImportedNames(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function insertResolvedImports(
  db: DB,
  importerPath: string,
  imports: ResolvedImport[],
): void {
  if (imports.length === 0) return;
  const stmt = db.prepare(
    "INSERT INTO resolved_imports (importer_path, source, resolved_path, imported_names, kind, is_type_only, is_external, is_builtin, package_name, resolution_method, unresolved_reason, span_start, span_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  for (const imp of imports) {
    stmt.run(
      importerPath,
      imp.source,
      imp.resolvedPath,
      JSON.stringify(imp.importedNames ?? []),
      imp.kind,
      imp.isTypeOnly ? 1 : 0,
      imp.isExternal ? 1 : 0,
      imp.isBuiltin ? 1 : 0,
      imp.packageName ?? null,
      imp.resolutionMethod ?? null,
      imp.unresolvedReason ?? null,
      imp.span?.start ?? null,
      imp.span?.end ?? null,
    );
  }
}

export function getResolvedImports(
  db: DB,
  importerPath: string,
): ResolvedImportRow[] {
  const rows = db
    .prepare(
      "SELECT importer_path, source, resolved_path, imported_names, kind, is_type_only, is_external, is_builtin, package_name, resolution_method, unresolved_reason, span_start, span_end FROM resolved_imports WHERE importer_path = ? ORDER BY id",
    )
    .all(importerPath) as Array<Omit<ResolvedImportRow, "imported_names"> & {
    imported_names: string | null;
  }>;

  return rows.map((row) => ({
    ...row,
    imported_names: parseImportedNames(row.imported_names),
  }));
}

export function getDependencies(db: DB, importerPath: string): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT resolved_path FROM resolved_imports WHERE importer_path = ? AND resolved_path IS NOT NULL ORDER BY resolved_path",
    )
    .all(importerPath) as Array<{ resolved_path: string }>;
  return rows.map((row) => row.resolved_path);
}

export function getDependents(db: DB, filePath: string): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT importer_path FROM resolved_imports WHERE resolved_path = ? ORDER BY importer_path",
    )
    .all(filePath) as Array<{ importer_path: string }>;
  return rows.map((row) => row.importer_path);
}

export function listExternalPackages(db: DB): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT package_name FROM resolved_imports WHERE is_external = 1 AND is_builtin = 0 AND package_name IS NOT NULL ORDER BY package_name",
    )
    .all() as Array<{ package_name: string }>;
  return rows.map((row) => row.package_name);
}
