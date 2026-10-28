import path from "node:path";

/** Repo root (apps/api/src → ../../..). `.env` lives there. */
export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

// Already-set env vars win over .env (tests rely on this to point at dct_finance_test).
try {
  process.loadEnvFile(path.join(REPO_ROOT, ".env"));
} catch {
  // no .env (fresh worktree, CI): fall through to defaults
}

const port = Number(process.env.PORT ?? 4100);
const list = (v: string | undefined, fallback: string[]) => (v ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : fallback);
const local = (p: number | string) => [`localhost:${p}`, `127.0.0.1:${p}`];

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://dct:dct@localhost:5434/dct_finance",
  uploadDir: process.env.UPLOAD_DIR ?? path.join(REPO_ROOT, "data/uploads"),
  port,
  /** Host headers accepted (DNS-rebinding guard). Web port 3100 too, in case the Next proxy forwards Host. */
  allowedHosts: list(process.env.ALLOWED_HOSTS, [...local(port), ...local(3100)]),
  /** Origins allowed on mutating requests (CSRF guard). */
  allowedOrigins: list(process.env.ALLOWED_ORIGINS, local(3100).map((h) => `http://${h}`)),
  extractionFake: process.env.EXTRACTION_FAKE === "1",
  /**
   * This computer only (user decision 2026-10-28). There's no login: every write's `by` is whatever name was picked. Login
   * must come before this listens anywhere else, or before more than one person uses it (docs/phase-1/api.md).
   */
  listenHost: "127.0.0.1",
  maxUploadBytes: 50 * 1024 * 1024,
  /** Pages per uploaded PDF; the same limit the reading has (@dct/extraction CONFIG.maxPagesPerDoc). */
  maxUploadPages: 100,
};
