import type { Database as DB } from "./sqlite.js";
import type { ReferenceKind, ReferenceList, ReferenceItem } from "../types.js";

export type ReferenceRow = {
  from_path: string;
  from_symbol_id: number | null;
  from_symbol_name: string | null;
  from_symbol_kind: string | null;
  from_symbol_parent: string | null;
  from_line: number;
  from_col: number | null;
  from_len: number | null;
  to_path: string | null;
  to_symbol_id: number | null;
  to_symbol_name: string;
  to_symbol_kind: string | null;
  to_symbol_parent: string | null;
  ref_kind: ReferenceKind;
  is_definition: number;
  module_specifier: string | null;
};

export type RefStateRow = {
  path: string;
  refs_extracted_at: string | null;
  refs_hash: string | null;
  project_hash: string | null;
};

export const STRUCTURAL_REF_KINDS: ReferenceKind[] = [
  "import",
  "reexport",
  "call",
  "instantiate",
  "type",
  "extends",
  "implements",
];

type ReferenceKey = {
  symbolId?: number | null;
  path?: string | null;
  name?: string;
  kind?: string | null;
  parent?: string | null;
};

type ReferenceQuery = {
  direction: "in" | "out";
  key: ReferenceKey;
  refKinds?: ReferenceKind[];
  maxItems?: number;
};

function buildWhere(
  direction: "in" | "out",
  key: ReferenceKey,
): { clause: string; params: Array<string | number | null> } {
  if (key.symbolId !== undefined && key.symbolId !== null) {
    const field = direction === "in" ? "to_symbol_id" : "from_symbol_id";
    return { clause: `${field} = ?`, params: [key.symbolId] };
  }

  const name = key.name ?? "";
  const path = key.path ?? null;
  const kind = key.kind ?? null;
  const parent = key.parent ?? null;
  const prefix = direction === "in" ? "to" : "from";
  return {
    clause: `${prefix}_path IS ? AND ${prefix}_symbol_name = ? AND ${prefix}_symbol_kind IS ? AND ${prefix}_symbol_parent IS ?`,
    params: [path, name, kind, parent],
  };
}

function buildRefKindFilter(refKinds?: ReferenceKind[]): {
  clause: string;
  params: ReferenceKind[];
} {
  if (!refKinds || refKinds.length === 0) {
    return { clause: "", params: [] };
  }
  const placeholders = refKinds.map(() => "?").join(", ");
  return {
    clause: ` AND ref_kind IN (${placeholders})`,
    params: refKinds,
  };
}

function toReferenceItem(
  direction: "in" | "out",
  row: ReferenceRow,
): ReferenceItem {
  if (direction === "in") {
    return {
      refPath: row.from_path,
      refLine: row.from_line,
      refCol: row.from_col,
      symbolPath: row.from_path,
      symbolName: row.from_symbol_name ?? "(module)",
      symbolKind: row.from_symbol_kind,
      symbolParent: row.from_symbol_parent,
      refKind: row.ref_kind,
      moduleSpecifier: row.module_specifier ?? null,
    };
  }

  return {
    refPath: row.from_path,
    refLine: row.from_line,
    refCol: row.from_col,
    symbolPath: row.to_path,
    symbolName: row.to_symbol_name,
    symbolKind: row.to_symbol_kind,
    symbolParent: row.to_symbol_parent,
    refKind: row.ref_kind,
    moduleSpecifier: row.module_specifier ?? null,
  };
}

export function insertReferences(db: DB, refs: ReferenceRow[]): void {
  if (refs.length === 0) return;
  const stmt = db.prepare(
    "INSERT INTO \"references\" (from_path, from_symbol_id, from_symbol_name, from_symbol_kind, from_symbol_parent, from_line, from_col, from_len, to_path, to_symbol_id, to_symbol_name, to_symbol_kind, to_symbol_parent, ref_kind, is_definition, module_specifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const ref of refs) {
    stmt.run(
      ref.from_path,
      ref.from_symbol_id,
      ref.from_symbol_name,
      ref.from_symbol_kind,
      ref.from_symbol_parent,
      ref.from_line,
      ref.from_col,
      ref.from_len,
      ref.to_path,
      ref.to_symbol_id,
      ref.to_symbol_name,
      ref.to_symbol_kind,
      ref.to_symbol_parent,
      ref.ref_kind,
      ref.is_definition,
      ref.module_specifier,
    );
  }
}

export function deleteReferencesFrom(db: DB, path: string): void {
  db.prepare("DELETE FROM \"references\" WHERE from_path = ?").run(path);
}

export function deleteRefState(db: DB, path: string): void {
  db.prepare("DELETE FROM ref_state WHERE path = ?").run(path);
}

export function upsertRefState(
  db: DB,
  path: string,
  refsHash: string,
  projectHash: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO ref_state (path, refs_extracted_at, refs_hash, project_hash) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET refs_extracted_at = excluded.refs_extracted_at, refs_hash = excluded.refs_hash, project_hash = excluded.project_hash",
  ).run(path, now, refsHash, projectHash);
}

export function getRefStates(db: DB): Map<string, RefStateRow> {
  const rows = db
    .prepare(
      "SELECT path, refs_extracted_at, refs_hash, project_hash FROM ref_state",
    )
    .all() as RefStateRow[];
  const map = new Map<string, RefStateRow>();
  for (const row of rows) {
    map.set(row.path, row);
  }
  return map;
}

export function getReferenceList(db: DB, query: ReferenceQuery): ReferenceList {
  const where = buildWhere(query.direction, query.key);
  const filter = buildRefKindFilter(query.refKinds);
  const whereClause = `WHERE ${where.clause}${filter.clause}`;
  const params = [...where.params, ...filter.params];

  const counts = db
    .prepare(
      `SELECT ref_kind, COUNT(*) as count FROM "references" ${whereClause} GROUP BY ref_kind`,
    )
    .all(...params) as Array<{ ref_kind: ReferenceKind; count: number }>;

  const byKind: Partial<Record<ReferenceKind, number>> = {};
  let storedTotal = 0;
  for (const row of counts) {
    byKind[row.ref_kind] = row.count;
    storedTotal += row.count;
  }

  let total = storedTotal;
  let sampled = storedTotal;

  if (query.direction === "in") {
    const summaryWhere = buildWhere("in", query.key);
    const summaryFilter = buildRefKindFilter(query.refKinds);
    const summaryClause = `WHERE ${summaryWhere.clause}${summaryFilter.clause}`;
    const summaryParams = [...summaryWhere.params, ...summaryFilter.params];
    const summaries = db
      .prepare(
        `SELECT ref_kind, total_count, sampled_count FROM reference_summaries ${summaryClause}`,
      )
      .all(...summaryParams) as Array<{
      ref_kind: ReferenceKind;
      total_count: number;
      sampled_count: number;
    }>;

    if (summaries.length > 0) {
      total = 0;
      sampled = 0;
      for (const summary of summaries) {
        byKind[summary.ref_kind] = summary.total_count;
        total += summary.total_count;
        sampled += summary.sampled_count;
      }
    }
  }

  const maxItems =
    query.maxItems && query.maxItems > 0 ? query.maxItems : undefined;
  const limitClause = maxItems ? ` LIMIT ${maxItems}` : "";

  const rows = db
    .prepare(
      `SELECT from_path, from_symbol_id, from_symbol_name, from_symbol_kind, from_symbol_parent, from_line, from_col, from_len, to_path, to_symbol_id, to_symbol_name, to_symbol_kind, to_symbol_parent, ref_kind, is_definition, module_specifier FROM "references" ${whereClause} ORDER BY from_path, from_line, id${limitClause}`,
    )
    .all(...params) as ReferenceRow[];

  const items = rows.map((row) => toReferenceItem(query.direction, row));

  return {
    total,
    sampled,
    byKind,
    items,
  };
}

export function listReferenceRows(
  db: DB,
  query: ReferenceQuery,
): ReferenceRow[] {
  const where = buildWhere(query.direction, query.key);
  const filter = buildRefKindFilter(query.refKinds);
  const whereClause = `WHERE ${where.clause}${filter.clause}`;
  const params = [...where.params, ...filter.params];

  return db
    .prepare(
      `SELECT from_path, from_symbol_id, from_symbol_name, from_symbol_kind, from_symbol_parent, from_line, from_col, from_len, to_path, to_symbol_id, to_symbol_name, to_symbol_kind, to_symbol_parent, ref_kind, is_definition, module_specifier FROM "references" ${whereClause} ORDER BY from_path, from_line, id`,
    )
    .all(...params) as ReferenceRow[];
}
