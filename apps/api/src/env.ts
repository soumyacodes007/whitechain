import { fileURLToPath } from "node:url";

/** Loads the repo-root .env if there is one. Without it, the process environment is the only config. */
export function loadEnv() {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
  } catch {
    // Missing .env is fine.
  }
}
