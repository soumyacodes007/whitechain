import { createPublicClient, http } from "viem";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db.ts";
import { loadEnv } from "./env.ts";
import { createIndexer } from "./indexer.ts";
import { dispatchDue } from "./webhooks.ts";

loadEnv();

const POLL_MS = 1_000;

/** Runs a job on a timer, never overlapping itself, and keeps going after an error such as an RPC timeout. */
function loop(name: string, job: () => Promise<unknown>) {
  const run = async () => {
    try {
      await job();
    } catch (error) {
      console.error(`${name} failed:`, error instanceof Error ? error.message : error);
    }
    setTimeout(run, POLL_MS);
  };
  void run();
}

const config = loadConfig();
const db = await createDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
const client = createPublicClient({ transport: http(config.rpcUrl, { retryCount: 3, timeout: 15_000 }) });
const indexer = createIndexer(db, client, config);

const app = buildApp({ db, config });
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`SettleKit API on http://localhost:${config.port} (${config.databaseUrl ? "Postgres" : "embedded Postgres"})`);

loop("indexer", indexer.tick);
loop("webhooks", () => dispatchDue(db));
