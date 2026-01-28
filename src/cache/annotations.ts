import type { Database as DB } from "./sqlite.js";
import type { SymbolKind, TagEntry, TagMap } from "../types.js";

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

export type FileAnnotationTagRow = {
  path: string;
  tag_key: string;
  tag_value: string;
  created_at: string;
  updated_at: string;
};

export type SymbolAnnotationTagRow = {
  path: string;
  symbol_name: string;
  symbol_kind: string;
  parent_name: string | null;
  signature: string;
  tag_key: string;
  tag_value: string;
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

function addTagToMap(map: TagMap, key: string, value: string): void {
  const list = map[key];
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else {
    map[key] = [value];
  }
}

function buildTagMap(rows: Array<{ tag_key: string; tag_value: string }>): TagMap {
  const tags: TagMap = {};
  for (const row of rows) {
    addTagToMap(tags, row.tag_key, row.tag_value);
  }
  return tags;
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

export function listFileAnnotationTags(
  db: DB,
  path?: string,
): FileAnnotationTagRow[] {
  if (path) {
    return db
      .prepare(
        "SELECT path, tag_key, tag_value, created_at, updated_at FROM file_annotation_tags WHERE path = ? ORDER BY tag_key, tag_value",
      )
      .all(path) as FileAnnotationTagRow[];
  }
  return db
    .prepare(
      "SELECT path, tag_key, tag_value, created_at, updated_at FROM file_annotation_tags ORDER BY path, tag_key, tag_value",
    )
    .all() as FileAnnotationTagRow[];
}

export function getFileAnnotationTags(db: DB, path: string): TagMap {
  const rows = db
    .prepare(
      "SELECT tag_key, tag_value FROM file_annotation_tags WHERE path = ? ORDER BY tag_key, tag_value",
    )
    .all(path) as Array<{ tag_key: string; tag_value: string }>;
  return buildTagMap(rows);
}

export function addFileAnnotationTags(
  db: DB,
  path: string,
  tags: TagEntry[],
): number {
  if (tags.length === 0) return 0;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    "INSERT INTO file_annotation_tags (path, tag_key, tag_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path, tag_key, tag_value) DO UPDATE SET updated_at = excluded.updated_at",
  );
  let changes = 0;
  for (const tag of tags) {
    changes += stmt.run(path, tag.key, tag.value, now, now).changes;
  }
  return changes;
}

export function removeFileAnnotationTags(
  db: DB,
  path: string,
  tags: TagEntry[],
): number {
  if (tags.length === 0) return 0;
  const stmt = db.prepare(
    "DELETE FROM file_annotation_tags WHERE path = ? AND tag_key = ? AND tag_value = ?",
  );
  let changes = 0;
  for (const tag of tags) {
    changes += stmt.run(path, tag.key, tag.value).changes;
  }
  return changes;
}

export function clearFileAnnotationTags(db: DB, path: string): number {
  return db
    .prepare("DELETE FROM file_annotation_tags WHERE path = ?")
    .run(path).changes;
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

export function listSymbolAnnotationTags(
  db: DB,
  path?: string,
): SymbolAnnotationTagRow[] {
  if (path) {
    return db
      .prepare(
        "SELECT path, symbol_name, symbol_kind, parent_name, signature, tag_key, tag_value, created_at, updated_at FROM symbol_annotation_tags WHERE path = ? ORDER BY symbol_name, tag_key, tag_value",
      )
      .all(path) as SymbolAnnotationTagRow[];
  }
  return db
    .prepare(
      "SELECT path, symbol_name, symbol_kind, parent_name, signature, tag_key, tag_value, created_at, updated_at FROM symbol_annotation_tags ORDER BY path, symbol_name, tag_key, tag_value",
    )
    .all() as SymbolAnnotationTagRow[];
}

export function getSymbolAnnotationTagsMap(
  db: DB,
  path: string,
): Map<string, TagMap> {
  const rows = db
    .prepare(
      "SELECT symbol_name, symbol_kind, COALESCE(parent_name, '') as parent_name, signature, tag_key, tag_value FROM symbol_annotation_tags WHERE path = ? ORDER BY symbol_name, tag_key, tag_value",
    )
    .all(path) as Array<{
    symbol_name: string;
    symbol_kind: string;
    parent_name: string;
    signature: string;
    tag_key: string;
    tag_value: string;
  }>;

  const map = new Map<string, TagMap>();
  for (const row of rows) {
    const key = symbolKey(
      row.symbol_name,
      row.symbol_kind,
      row.parent_name,
      row.signature,
    );
    const entry = map.get(key) ?? {};
    addTagToMap(entry, row.tag_key, row.tag_value);
    map.set(key, entry);
  }

  return map;
}

export function addSymbolAnnotationTags(
  db: DB,
  key: SymbolAnnotationKey,
  tags: TagEntry[],
): number {
  if (tags.length === 0) return 0;
  const now = new Date().toISOString();
  const signature = key.signature ?? "";
  const stmt = db.prepare(
    "INSERT INTO symbol_annotation_tags (path, symbol_name, symbol_kind, parent_name, signature, tag_key, tag_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path, symbol_name, symbol_kind, parent_name, signature, tag_key, tag_value) DO UPDATE SET updated_at = excluded.updated_at",
  );
  let changes = 0;
  for (const tag of tags) {
    changes += stmt.run(
      key.path,
      key.symbolName,
      key.symbolKind,
      key.parentName ?? null,
      signature,
      tag.key,
      tag.value,
      now,
      now,
    ).changes;
  }
  return changes;
}

export function removeSymbolAnnotationTags(
  db: DB,
  key: SymbolAnnotationKey,
  tags: TagEntry[],
): number {
  if (tags.length === 0) return 0;
  const signature = key.signature ?? "";
  const stmt = db.prepare(
    "DELETE FROM symbol_annotation_tags WHERE path = ? AND symbol_name = ? AND symbol_kind = ? AND COALESCE(parent_name, '') = COALESCE(?, '') AND signature = ? AND tag_key = ? AND tag_value = ?",
  );
  let changes = 0;
  for (const tag of tags) {
    changes += stmt.run(
      key.path,
      key.symbolName,
      key.symbolKind,
      key.parentName ?? null,
      signature,
      tag.key,
      tag.value,
    ).changes;
  }
  return changes;
}

export function clearSymbolAnnotationTags(
  db: DB,
  key: SymbolAnnotationKey,
): number {
  const signature = key.signature ?? "";
  return db
    .prepare(
      "DELETE FROM symbol_annotation_tags WHERE path = ? AND symbol_name = ? AND symbol_kind = ? AND COALESCE(parent_name, '') = COALESCE(?, '') AND signature = ?",
    )
    .run(
      key.path,
      key.symbolName,
      key.symbolKind,
      key.parentName ?? null,
      signature,
    ).changes;
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

export function listTagCounts(
  db: DB,
  opts: { key?: string; scope?: "files" | "symbols" | "all" } = {},
): Array<{ key: string; value: string; fileCount: number; symbolCount: number }> {
  const scope = opts.scope ?? "all";
  const keyFilter = opts.key;
  const counts = new Map<
    string,
    { key: string; value: string; fileCount: number; symbolCount: number }
  >();

  if (scope !== "symbols") {
    const where = keyFilter ? "WHERE tag_key = ?" : "";
    const rows = db
      .prepare(
        `SELECT tag_key, tag_value, COUNT(*) as count FROM file_annotation_tags ${where} GROUP BY tag_key, tag_value`,
      )
      .all(...(keyFilter ? [keyFilter] : [])) as Array<{
      tag_key: string;
      tag_value: string;
      count: number;
    }>;
    for (const row of rows) {
      const key = `${row.tag_key}\u0000${row.tag_value}`;
      counts.set(key, {
        key: row.tag_key,
        value: row.tag_value,
        fileCount: row.count,
        symbolCount: 0,
      });
    }
  }

  if (scope !== "files") {
    const where = keyFilter ? "WHERE tag_key = ?" : "";
    const rows = db
      .prepare(
        `SELECT tag_key, tag_value, COUNT(*) as count FROM symbol_annotation_tags ${where} GROUP BY tag_key, tag_value`,
      )
      .all(...(keyFilter ? [keyFilter] : [])) as Array<{
      tag_key: string;
      tag_value: string;
      count: number;
    }>;
    for (const row of rows) {
      const key = `${row.tag_key}\u0000${row.tag_value}`;
      const existing = counts.get(key);
      if (existing) {
        existing.symbolCount = row.count;
      } else {
        counts.set(key, {
          key: row.tag_key,
          value: row.tag_value,
          fileCount: 0,
          symbolCount: row.count,
        });
      }
    }
  }

  return Array.from(counts.values()).sort((a, b) => {
    if (a.key !== b.key) return a.key.localeCompare(b.key);
    return a.value.localeCompare(b.value);
  });
}

export function listUnannotatedFiles(db: DB): string[] {
  const rows = db
    .prepare(
      `SELECT f.path FROM files f
       WHERE NOT EXISTS (SELECT 1 FROM file_annotations fa WHERE fa.path = f.path)
         AND NOT EXISTS (SELECT 1 FROM file_annotation_tags fat WHERE fat.path = f.path)
         AND NOT EXISTS (SELECT 1 FROM symbol_annotations sa WHERE sa.path = f.path)
         AND NOT EXISTS (SELECT 1 FROM symbol_annotation_tags sat WHERE sat.path = f.path)
       ORDER BY f.path`,
    )
    .all() as Array<{ path: string }>;
  return rows.map((row) => row.path);
}

export function listOrphanedFileAnnotations(db: DB): FileAnnotationRow[] {
  return db
    .prepare(
      "SELECT path, note, created_at, updated_at FROM file_annotations WHERE path NOT IN (SELECT path FROM files) ORDER BY path",
    )
    .all() as FileAnnotationRow[];
}

export function listOrphanedFileAnnotationTags(
  db: DB,
): FileAnnotationTagRow[] {
  return db
    .prepare(
      "SELECT path, tag_key, tag_value, created_at, updated_at FROM file_annotation_tags WHERE path NOT IN (SELECT path FROM files) ORDER BY path, tag_key, tag_value",
    )
    .all() as FileAnnotationTagRow[];
}

export function listOrphanedSymbolAnnotations(db: DB): SymbolAnnotationRow[] {
  return db
    .prepare(
      "SELECT path, symbol_name, symbol_kind, parent_name, signature, note, created_at, updated_at FROM symbol_annotations sa LEFT JOIN symbols s ON sa.path = s.path AND sa.symbol_name = s.name AND sa.symbol_kind = s.kind AND COALESCE(sa.parent_name, '') = COALESCE(s.parent_name, '') AND (sa.signature = '' OR COALESCE(sa.signature, '') = COALESCE(s.signature, '')) WHERE s.id IS NULL ORDER BY path, symbol_name",
    )
    .all() as SymbolAnnotationRow[];
}

export function listOrphanedSymbolAnnotationTags(
  db: DB,
): SymbolAnnotationTagRow[] {
  return db
    .prepare(
      "SELECT path, symbol_name, symbol_kind, parent_name, signature, tag_key, tag_value, created_at, updated_at FROM symbol_annotation_tags sa LEFT JOIN symbols s ON sa.path = s.path AND sa.symbol_name = s.name AND sa.symbol_kind = s.kind AND COALESCE(sa.parent_name, '') = COALESCE(s.parent_name, '') AND (sa.signature = '' OR COALESCE(sa.signature, '') = COALESCE(s.signature, '')) WHERE s.id IS NULL ORDER BY path, symbol_name, tag_key, tag_value",
    )
    .all() as SymbolAnnotationTagRow[];
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
  const symbolTagRow = db
    .prepare(
      "SELECT COUNT(*) as count FROM symbol_annotation_tags sa LEFT JOIN symbols s ON sa.path = s.path AND sa.symbol_name = s.name AND sa.symbol_kind = s.kind AND COALESCE(sa.parent_name, '') = COALESCE(s.parent_name, '') AND (sa.signature = '' OR COALESCE(sa.signature, '') = COALESCE(s.signature, '')) WHERE s.id IS NULL",
    )
    .get() as { count: number } | undefined;
  const fileRow = db
    .prepare(
      "SELECT COUNT(*) as count FROM file_annotations fa LEFT JOIN files f ON fa.path = f.path WHERE f.path IS NULL",
    )
    .get() as { count: number } | undefined;
  const fileTagRow = db
    .prepare(
      "SELECT COUNT(*) as count FROM file_annotation_tags fa LEFT JOIN files f ON fa.path = f.path WHERE f.path IS NULL",
    )
    .get() as { count: number } | undefined;

  return {
    file: (fileRow?.count ?? 0) + (fileTagRow?.count ?? 0),
    symbol: (symbolRow?.count ?? 0) + (symbolTagRow?.count ?? 0),
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
  const symbolTagResult = db
    .prepare(
      "DELETE FROM symbol_annotation_tags WHERE rowid IN (SELECT sa.rowid FROM symbol_annotation_tags sa LEFT JOIN symbols s ON sa.path = s.path AND sa.symbol_name = s.name AND sa.symbol_kind = s.kind AND COALESCE(sa.parent_name, '') = COALESCE(s.parent_name, '') AND (sa.signature = '' OR COALESCE(sa.signature, '') = COALESCE(s.signature, '')) WHERE s.id IS NULL)",
    )
    .run();

  const fileResult = db
    .prepare(
      "DELETE FROM file_annotations WHERE path IN (SELECT fa.path FROM file_annotations fa LEFT JOIN files f ON fa.path = f.path WHERE f.path IS NULL)",
    )
    .run();
  const fileTagResult = db
    .prepare(
      "DELETE FROM file_annotation_tags WHERE path IN (SELECT fa.path FROM file_annotation_tags fa LEFT JOIN files f ON fa.path = f.path WHERE f.path IS NULL)",
    )
    .run();

  return {
    file: fileResult.changes + fileTagResult.changes,
    symbol: symbolResult.changes + symbolTagResult.changes,
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
