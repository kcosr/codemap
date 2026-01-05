import Database from "better-sqlite3";
import type { SymbolKind } from "../types.js";
type DB = Database.Database;

export type SymbolAnnotationKey = {
  path: string;
  symbolName: string;
  symbolKind: SymbolKind | string;
  parentName?: string | null;
  signature?: string | null;
};

export type FileAnnotationRow = {
  path: string;
  note: string;
  created_at: string;
  updated_at: string;
};

export type SymbolAnnotationRow = {
  path: string;
  symbol_name: string;
  symbol_kind: string;
  parent_name: string | null;
  signature: string;
  note: string;
  created_at: string;
  updated_at: string;
};

function symbolKey(
  name: string,
  kind: string,
  parentName: string | null,
  signature: string,
): string {
  return `${name}\u0000${kind}\u0000${parentName ?? ""}\u0000${signature}`;
}

export function getFileAnnotation(
  db: DB,
  path: string,
): string | null {
  const row = db
    .prepare("SELECT note FROM file_annotations WHERE path = ?")
    .get(path) as { note: string } | undefined;
  return row?.note ?? null;
}

export function setFileAnnotation(
  db: DB,
  path: string,
  note: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO file_annotations (path, note, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at",
  ).run(path, note, now, now);
}

export function removeFileAnnotation(db: DB, path: string): number {
  return db
    .prepare("DELETE FROM file_annotations WHERE path = ?")
    .run(path).changes;
}

export function listFileAnnotations(
  db: DB,
  path?: string,
): FileAnnotationRow[] {
  if (path) {
    return db
      .prepare(
        "SELECT path, note, created_at, updated_at FROM file_annotations WHERE path = ? ORDER BY path",
      )
      .all(path) as FileAnnotationRow[];
  }
  return db
    .prepare(
      "SELECT path, note, created_at, updated_at FROM file_annotations ORDER BY path",
    )
    .all() as FileAnnotationRow[];
}

export function getSymbolAnnotation(
  db: DB,
  key: SymbolAnnotationKey,
): string | null {
  const signature = key.signature ?? "";
  const row = db
    .prepare(
      "SELECT note FROM symbol_annotations WHERE path = ? AND symbol_name = ? AND symbol_kind = ? AND COALESCE(parent_name, '') = COALESCE(?, '') AND signature = ?",
    )
    .get(
      key.path,
      key.symbolName,
      key.symbolKind,
      key.parentName ?? null,
      signature,
    ) as { note: string } | undefined;
  if (row?.note) return row.note;

  if (signature !== "") {
    const fallback = db
      .prepare(
        "SELECT note FROM symbol_annotations WHERE path = ? AND symbol_name = ? AND symbol_kind = ? AND COALESCE(parent_name, '') = COALESCE(?, '') AND signature = ''",
      )
      .get(
        key.path,
        key.symbolName,
        key.symbolKind,
        key.parentName ?? null,
      ) as { note: string } | undefined;
    return fallback?.note ?? null;
  }

  return null;
}

export function setSymbolAnnotation(
  db: DB,
  key: SymbolAnnotationKey,
  note: string,
): void {
  const now = new Date().toISOString();
  const signature = key.signature ?? "";
  db.prepare(
    "INSERT INTO symbol_annotations (path, symbol_name, symbol_kind, parent_name, signature, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path, symbol_name, symbol_kind, parent_name, signature) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at",
  ).run(
    key.path,
    key.symbolName,
    key.symbolKind,
    key.parentName ?? null,
    signature,
    note,
    now,
    now,
  );
}

export function removeSymbolAnnotation(
  db: DB,
  key: SymbolAnnotationKey,
): number {
  const signature = key.signature ?? "";
  return db
    .prepare(
      "DELETE FROM symbol_annotations WHERE path = ? AND symbol_name = ? AND symbol_kind = ? AND COALESCE(parent_name, '') = COALESCE(?, '') AND signature = ?",
    )
    .run(
      key.path,
      key.symbolName,
      key.symbolKind,
      key.parentName ?? null,
      signature,
    ).changes;
}

export function listSymbolAnnotations(
  db: DB,
  path?: string,
): SymbolAnnotationRow[] {
  if (path) {
    return db
      .prepare(
        "SELECT path, symbol_name, symbol_kind, parent_name, signature, note, created_at, updated_at FROM symbol_annotations WHERE path = ? ORDER BY symbol_name",
      )
      .all(path) as SymbolAnnotationRow[];
  }
  return db
    .prepare(
      "SELECT path, symbol_name, symbol_kind, parent_name, signature, note, created_at, updated_at FROM symbol_annotations ORDER BY path, symbol_name",
    )
    .all() as SymbolAnnotationRow[];
}

export function getSymbolAnnotationMap(
  db: DB,
  path: string,
): Map<string, string> {
  const rows = db
    .prepare(
      "SELECT symbol_name, symbol_kind, COALESCE(parent_name, '') as parent_name, signature, note FROM symbol_annotations WHERE path = ?",
    )
    .all(path) as Array<{
    symbol_name: string;
    symbol_kind: string;
    parent_name: string;
    signature: string;
    note: string;
  }>;

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(
      symbolKey(row.symbol_name, row.symbol_kind, row.parent_name, row.signature),
      row.note,
    );
  }
  return map;
}

export function countOrphanedAnnotations(db: DB): {
  file: number;
  symbol: number;
} {
  const symbolRow = db
    .prepare(
      "SELECT COUNT(*) as count FROM symbol_annotations sa LEFT JOIN symbols s ON sa.path = s.path AND sa.symbol_name = s.name AND sa.symbol_kind = s.kind AND COALESCE(sa.parent_name, '') = COALESCE(s.parent_name, '') AND (sa.signature = '' OR COALESCE(sa.signature, '') = COALESCE(s.signature, '')) WHERE s.id IS NULL",
    )
    .get() as { count: number } | undefined;
  const fileRow = db
    .prepare(
      "SELECT COUNT(*) as count FROM file_annotations fa LEFT JOIN files f ON fa.path = f.path WHERE f.path IS NULL",
    )
    .get() as { count: number } | undefined;

  return {
    file: fileRow?.count ?? 0,
    symbol: symbolRow?.count ?? 0,
  };
}

export function pruneOrphanedAnnotations(db: DB): {
  file: number;
  symbol: number;
} {
  const symbolResult = db
    .prepare(
      "DELETE FROM symbol_annotations WHERE id IN (SELECT sa.id FROM symbol_annotations sa LEFT JOIN symbols s ON sa.path = s.path AND sa.symbol_name = s.name AND sa.symbol_kind = s.kind AND COALESCE(sa.parent_name, '') = COALESCE(s.parent_name, '') AND (sa.signature = '' OR COALESCE(sa.signature, '') = COALESCE(s.signature, '')) WHERE s.id IS NULL)",
    )
    .run();

  const fileResult = db
    .prepare(
      "DELETE FROM file_annotations WHERE path IN (SELECT fa.path FROM file_annotations fa LEFT JOIN files f ON fa.path = f.path WHERE f.path IS NULL)",
    )
    .run();

  return {
    file: fileResult.changes,
    symbol: symbolResult.changes,
  };
}

export function buildSymbolAnnotationKey(
  name: string,
  kind: string,
  parentName: string | null,
  signature: string | null,
): string {
  return symbolKey(name, kind, parentName, signature ?? "");
}
