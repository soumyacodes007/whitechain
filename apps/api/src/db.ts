import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export type Queryable = {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
};

export type Db = Queryable & {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

function fromPool(pool: pg.Pool): Db {
  return {
    query: async (sql, params) => (await pool.query(sql, params as any[])).rows,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({ query: async (sql, params) => (await client.query(sql, params as any[])).rows });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function fromPglite(lite: PGlite): Db {
  return {
    query: async (sql, params) => (await lite.query<any>(sql, params as any[])).rows,
    tx: (fn) =>
      lite.transaction((t) => fn({ query: async (sql, params) => (await t.query<any>(sql, params as any[])).rows })),
    close: () => lite.close(),
  };
}

/** Uses Postgres when a URL is given, otherwise embedded Postgres. Pass no dataDir to keep it in memory. */
export async function createDb(options: { databaseUrl?: string; dataDir?: string }): Promise<Db> {
  const db = options.databaseUrl
    ? fromPool(new pg.Pool({ connectionString: options.databaseUrl }))
    : fromPglite(await PGlite.create(options.dataDir));
  await migrate(db);
  return db;
}

async function migrate(db: Db) {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)");
  const dir = fileURLToPath(new URL("./migrations/", import.meta.url));
  const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));

  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(name)) continue;
    const statements = readFileSync(dir + name, "utf8")
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    await db.tx(async (q) => {
      for (const statement of statements) await q.query(statement);
      await q.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    });
  }
}
