import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** The nearest folder upwards from this file that holds `name`: the same from src, from dist and from a bundle's chunk. */
export function findUp(name: string, from = import.meta.dirname): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, name))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** Repo root, where `.env` lives; null when the API runs outside the repo (then every setting comes from the environment). */
const REPO_ROOT = findUp("pnpm-workspace.yaml");

const DEV_DATABASE_URL = "postgres://dct:dct@localhost:5434/dct_finance";
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const whole = (min: number, max: number, what: string) =>
  z.coerce.number({ error: `must be ${what}` }).int({ error: `must be ${what}` }).min(min, { error: `must be ${what}` }).max(max, { error: `must be ${what}` });
const ms = (min: number, max: number) => whole(min, max, `a number of milliseconds from ${min} to ${max}`);
const list = z.string().transform((v) => v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

/**
 * Every setting the API reads, checked once at startup. Messages name the setting and what it must be, never its value:
 * DATABASE_URL is a secret (zod leaves the input out of its issues). The AI keys aren't read here: nothing needs them yet.
 */
const Env = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: "must be a postgres:// connection URL" }).default(DEV_DATABASE_URL),
  PORT: whole(1, 65535, "a port number from 1 to 65535").default(4100),
  UPLOAD_DIR: z.string().refine((p) => path.isAbsolute(p), { error: "must be an absolute path" }).optional(),
  ALLOWED_HOSTS: list.optional(),
  ALLOWED_ORIGINS: list.pipe(z.array(z.url({ protocol: /^https?$/, error: "must be a comma-separated list of origins, e.g. http://localhost:3100" }))).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(", ")}` }).default("info"),
  DB_POOL_MAX: whole(1, 100, "a whole number from 1 to 100").default(10),
  JOBS_DB_POOL_MAX: whole(2, 50, "a whole number from 2 to 50").default(5),
  DB_STATEMENT_TIMEOUT_MS: ms(1000, 600_000).default(30_000),
  DB_LOCK_TIMEOUT_MS: ms(100, 120_000).default(10_000),
  REQUEST_TIMEOUT_MS: ms(1000, 3_600_000).default(120_000),
  KEEP_ALIVE_TIMEOUT_MS: ms(1000, 600_000).default(72_000),
  SHUTDOWN_TIMEOUT_MS: ms(1000, 600_000).default(30_000),
});

/** What one setting needs from another; checked on the raw values, so they're reported along with any others. */
function needs(env: Record<string, string>): string[] {
  const out: string[] = [];
  if (!env.UPLOAD_DIR && !REPO_ROOT) out.push("UPLOAD_DIR is needed when the API runs outside the repo");
  // outside the repo the dev default would point a deployed API at a developer's database
  if (!env.DATABASE_URL && !REPO_ROOT) out.push("DATABASE_URL is needed when the API runs outside the repo");
  return out;
}

export class ConfigError extends Error {}

/** The API's settings from `env`; a ConfigError listing every bad setting (names only, never values) otherwise. */
export function parseConfig(env: NodeJS.ProcessEnv) {
  // an empty value is an unset one (`PORT=` in .env)
  const set = Object.fromEntries(Object.entries(env).filter((kv): kv is [string, string] => kv[1] !== undefined && kv[1] !== ""));
  const r = Env.safeParse(set);
  const lines = [...(r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`)), ...needs(set)];
  if (!r.success || lines.length) throw new ConfigError(`The API's settings aren't valid (check .env or the environment):\n${lines.map((l) => `  - ${l}`).join("\n")}`);
  const e = r.data;
  const local = (p: number | string) => [`localhost:${p}`, `127.0.0.1:${p}`];
  return {
    databaseUrl: e.DATABASE_URL,
    uploadDir: e.UPLOAD_DIR ?? path.join(REPO_ROOT!, "data/uploads"),
    port: e.PORT,
    /** Host headers accepted (DNS-rebinding guard). Web port 3100 too, in case the Next proxy forwards Host. */
    allowedHosts: e.ALLOWED_HOSTS ?? [...local(e.PORT), ...local(3100)],
    /** Origins allowed on mutating requests (CSRF guard). */
    allowedOrigins: e.ALLOWED_ORIGINS ?? local(3100).map((h) => `http://${h}`),
    /**
     * This computer only (user decision 2026-10-28). There's no login: every write's `by` is whatever name was picked. Login
     * must come before this listens anywhere else, or before more than one person uses it.
     */
    listenHost: "127.0.0.1",
    logLevel: e.LOG_LEVEL,
    db: { max: e.DB_POOL_MAX, statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS, lockTimeoutMs: e.DB_LOCK_TIMEOUT_MS },
    jobsDbMax: e.JOBS_DB_POOL_MAX,
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    keepAliveTimeoutMs: e.KEEP_ALIVE_TIMEOUT_MS,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    maxUploadBytes: 50 * 1024 * 1024,
  };
}

// Already-set env vars win over .env (tests rely on this to point at dct_finance_test).
try {
  if (REPO_ROOT) process.loadEnvFile(path.join(REPO_ROOT, ".env"));
} catch (err) {
  // no .env (fresh worktree, CI) is fine; one that can't be read isn't
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

function load() {
  try {
    return parseConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Fail fast, before anything listens or connects; the message alone, without a stack trace.
    console.error(err.message);
    process.exit(1);
  }
}

export const config = load();
