/**
 * SQLite database abstraction layer.
 * Uses bun:sqlite when running in Bun, better-sqlite3 otherwise.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isBun = typeof (globalThis as any).Bun !== "undefined";

type StatementLike = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
};

export type Database = {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  pragma(cmd: string): unknown;
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
  close(): void;
};

type DatabaseConstructor = new (path: string) => Database;

async function loadDatabase(): Promise<DatabaseConstructor> {
  if (isBun) {
    // Dynamic import for bun:sqlite (only available at runtime in Bun)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BunDatabase = (await import(/* webpackIgnore: true */ "bun:sqlite" as any)).default;

    // Wrapper to normalize Bun's API to match better-sqlite3
    return class BunDatabaseWrapper implements Database {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      private db: any;

      constructor(path: string) {
        this.db = new BunDatabase(path);
      }

      exec(sql: string): void {
        this.db.exec(sql);
      }

      prepare(sql: string): StatementLike {
        const stmt = this.db.query(sql);
        return {
          all: (...params: unknown[]) => stmt.all(...params) as unknown[],
          get: (...params: unknown[]) => stmt.get(...params),
          run: (...params: unknown[]) => {
            stmt.run(...params);
            // Bun doesn't return changes from run(), need to query it
            const changesRow = this.db.query("SELECT changes() as changes, last_insert_rowid() as lastInsertRowid").get() as { changes: number; lastInsertRowid: number };
            return { changes: changesRow.changes, lastInsertRowid: changesRow.lastInsertRowid };
          },
        };
      }

      pragma(cmd: string): unknown {
        // Parse "key = value" format
        const eqIdx = cmd.indexOf("=");
        if (eqIdx !== -1) {
          this.db.exec(`PRAGMA ${cmd}`);
          return undefined;
        }
        // Query-style pragma
        const result = this.db.query(`PRAGMA ${cmd}`).get();
        return result;
      }

      transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
        return this.db.transaction(fn) as T;
      }

      close(): void {
        this.db.close();
      }
    } as DatabaseConstructor;
  } else {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    return BetterSqlite3 as unknown as DatabaseConstructor;
  }
}

const DatabaseImpl = await loadDatabase();
export default DatabaseImpl;
