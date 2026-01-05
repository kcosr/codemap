import Database from "better-sqlite3";

export type CacheMeta = {
  createdAt: string | null;
  lastUpdatedAt: string | null;
  extractorVersion: string | null;
};
type DB = Database.Database;

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function readMeta(db: DB): CacheMeta {
  return {
    createdAt: getMeta(db, "created_at"),
    lastUpdatedAt: getMeta(db, "last_updated_at"),
    extractorVersion: getMeta(db, "extractor_version"),
  };
}

export function ensureMeta(
  db: DB,
  extractorVersion: string,
): CacheMeta {
  const now = new Date().toISOString();
  let createdAt = getMeta(db, "created_at");
  if (!createdAt) {
    setMeta(db, "created_at", now);
    createdAt = now;
  }

  let version = getMeta(db, "extractor_version");
  if (!version) {
    setMeta(db, "extractor_version", extractorVersion);
    version = extractorVersion;
  }

  return {
    createdAt,
    lastUpdatedAt: getMeta(db, "last_updated_at"),
    extractorVersion: version,
  };
}

export function updateLastUpdated(db: DB): string {
  const now = new Date().toISOString();
  setMeta(db, "last_updated_at", now);
  return now;
}
