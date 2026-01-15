import type { Database as DB } from "./sqlite.js";

export const SCHEMA_VERSION = 4;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  language TEXT NOT NULL CHECK(language IN ('typescript','javascript','markdown','cpp','other')),
  line_count INTEGER NOT NULL,
  extractor_version TEXT NOT NULL DEFAULT '1',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (
    'function','class','interface','type','variable','enum','enum_member',
    'method','property','constructor','getter','setter',
    'namespace','struct','destructor'
  )),
  signature TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_async INTEGER NOT NULL DEFAULT 0,
  is_static INTEGER NOT NULL DEFAULT 0,
  is_abstract INTEGER NOT NULL DEFAULT 0,
  parent_name TEXT,
  jsdoc TEXT,
  FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL,
  FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE,
  UNIQUE(path, source)
);

CREATE TABLE IF NOT EXISTS headings (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 6),
  text TEXT NOT NULL,
  line INTEGER NOT NULL,
  FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS code_blocks (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  language TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS file_annotations (
  path TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbol_annotations (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  symbol_kind TEXT NOT NULL,
  parent_name TEXT,
  signature TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(path, symbol_name, symbol_kind, parent_name, signature)
);

CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_name);
CREATE INDEX IF NOT EXISTS idx_symbols_lookup ON symbols(path, parent_name, kind, name);

CREATE INDEX IF NOT EXISTS idx_imports_path ON imports(path);
CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source);
CREATE INDEX IF NOT EXISTS idx_headings_path ON headings(path);
CREATE INDEX IF NOT EXISTS idx_code_blocks_path ON code_blocks(path);

CREATE INDEX IF NOT EXISTS idx_symbol_annotations_path ON symbol_annotations(path);
CREATE INDEX IF NOT EXISTS idx_file_annotations_path ON file_annotations(path);
`;

const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS resolved_imports (
  id INTEGER PRIMARY KEY,
  importer_path TEXT NOT NULL,
  source TEXT NOT NULL,
  resolved_path TEXT,
  imported_names TEXT,
  kind TEXT NOT NULL,
  is_type_only INTEGER NOT NULL DEFAULT 0,
  is_external INTEGER NOT NULL DEFAULT 0,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  package_name TEXT,
  resolution_method TEXT,
  unresolved_reason TEXT,
  span_start INTEGER,
  span_end INTEGER,
  FOREIGN KEY (importer_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_resolved_imports_importer ON resolved_imports(importer_path);
CREATE INDEX IF NOT EXISTS idx_resolved_imports_resolved ON resolved_imports(resolved_path);
CREATE INDEX IF NOT EXISTS idx_resolved_imports_external ON resolved_imports(is_external);
CREATE INDEX IF NOT EXISTS idx_resolved_imports_package ON resolved_imports(package_name);
CREATE UNIQUE INDEX IF NOT EXISTS ux_resolved_imports_stmt
  ON resolved_imports(importer_path, kind, source, span_start, span_end);
`;

const MIGRATION_3 = `
CREATE TABLE IF NOT EXISTS "references" (
  id INTEGER PRIMARY KEY,
  from_path TEXT NOT NULL,
  from_symbol_id INTEGER,
  from_symbol_name TEXT,
  from_symbol_kind TEXT,
  from_symbol_parent TEXT,
  from_line INTEGER NOT NULL,
  from_col INTEGER,
  from_len INTEGER,
  to_path TEXT,
  to_symbol_id INTEGER,
  to_symbol_name TEXT NOT NULL,
  to_symbol_kind TEXT,
  to_symbol_parent TEXT,
  ref_kind TEXT NOT NULL,
  is_definition INTEGER NOT NULL DEFAULT 0,
  module_specifier TEXT,
  FOREIGN KEY (from_path) REFERENCES files(path) ON DELETE CASCADE,
  FOREIGN KEY (to_path) REFERENCES files(path) ON DELETE CASCADE,
  FOREIGN KEY (from_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE,
  FOREIGN KEY (to_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refs_from_path ON "references"(from_path);
CREATE INDEX IF NOT EXISTS idx_refs_to_path ON "references"(to_path);
CREATE INDEX IF NOT EXISTS idx_refs_kind ON "references"(ref_kind);
CREATE INDEX IF NOT EXISTS idx_refs_from_symbol_id ON "references"(from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_refs_to_symbol_id ON "references"(to_symbol_id);
CREATE INDEX IF NOT EXISTS idx_refs_to_fallback
  ON "references"(to_path, to_symbol_name, to_symbol_kind, to_symbol_parent);
CREATE INDEX IF NOT EXISTS idx_refs_from_fallback
  ON "references"(from_path, from_symbol_name, from_symbol_kind, from_symbol_parent);
CREATE INDEX IF NOT EXISTS idx_refs_to_file_kind ON "references"(to_path, ref_kind);

CREATE TABLE IF NOT EXISTS reference_summaries (
  to_symbol_id INTEGER,
  to_path TEXT,
  to_symbol_name TEXT NOT NULL,
  to_symbol_kind TEXT,
  to_symbol_parent TEXT,
  ref_kind TEXT NOT NULL,
  total_count INTEGER NOT NULL,
  sampled_count INTEGER NOT NULL,
  PRIMARY KEY (to_symbol_id, ref_kind),
  FOREIGN KEY (to_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE,
  FOREIGN KEY (to_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ref_summaries_to_symbol
  ON reference_summaries(to_symbol_id);
CREATE INDEX IF NOT EXISTS idx_ref_summaries_fallback
  ON reference_summaries(to_path, to_symbol_name, to_symbol_kind, to_symbol_parent);

CREATE TABLE IF NOT EXISTS ref_state (
  path TEXT PRIMARY KEY,
  refs_extracted_at TEXT,
  refs_hash TEXT,
  project_hash TEXT,
  FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
);
`;

const MIGRATION_4 = `
PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS files_new (
  path TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  language TEXT NOT NULL CHECK(language IN ('typescript','javascript','markdown','cpp','other')),
  line_count INTEGER NOT NULL,
  extractor_version TEXT NOT NULL DEFAULT '1',
  updated_at TEXT NOT NULL
);

INSERT INTO files_new (
  path,
  mtime,
  size,
  hash,
  language,
  line_count,
  extractor_version,
  updated_at
)
SELECT
  path,
  mtime,
  size,
  hash,
  language,
  line_count,
  extractor_version,
  updated_at
FROM files;

DROP TABLE files;
ALTER TABLE files_new RENAME TO files;

CREATE TABLE IF NOT EXISTS symbols_new (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (
    'function','class','interface','type','variable','enum','enum_member',
    'method','property','constructor','getter','setter',
    'namespace','struct','destructor'
  )),
  signature TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_async INTEGER NOT NULL DEFAULT 0,
  is_static INTEGER NOT NULL DEFAULT 0,
  is_abstract INTEGER NOT NULL DEFAULT 0,
  parent_name TEXT,
  jsdoc TEXT,
  FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
);

INSERT INTO symbols_new (
  id,
  path,
  name,
  kind,
  signature,
  start_line,
  end_line,
  exported,
  is_default,
  is_async,
  is_static,
  is_abstract,
  parent_name,
  jsdoc
)
SELECT
  id,
  path,
  name,
  kind,
  signature,
  start_line,
  end_line,
  exported,
  is_default,
  is_async,
  is_static,
  is_abstract,
  parent_name,
  jsdoc
FROM symbols;

DROP TABLE symbols;
ALTER TABLE symbols_new RENAME TO symbols;

CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_name);
CREATE INDEX IF NOT EXISTS idx_symbols_lookup ON symbols(path, parent_name, kind, name);

PRAGMA foreign_keys=ON;
`;

export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const row = db
    .prepare("SELECT MAX(version) as version FROM schema_migrations")
    .get() as { version: number | null } | undefined;
  const currentVersion = row?.version ?? 0;

  if (currentVersion >= SCHEMA_VERSION) return;

  const apply = db.transaction(() => {
    if (currentVersion < 1) {
      db.exec(MIGRATION_1);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(1, new Date().toISOString());
    }
    if (currentVersion < 2) {
      db.exec(MIGRATION_2);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(2, new Date().toISOString());
    }
    if (currentVersion < 3) {
      db.exec(MIGRATION_3);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(3, new Date().toISOString());
    }
    if (currentVersion < 4) {
      db.exec(MIGRATION_4);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(4, new Date().toISOString());
    }
  });

  apply();
}
