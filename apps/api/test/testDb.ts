import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb } from "../src/db.ts";

/** Embedded Postgres by default. Set TEST_DATABASE_URL to run on a server, with one new database per file. */
export async function createTestDb() {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) return createDb({});

  const name = `test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return createDb({ databaseUrl: url.toString() });
}
