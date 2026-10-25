import path from "node:path";

/** Repo root (apps/api/src → ../../..). `.env` lives there. */
export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

// Already-set env vars win over .env (tests rely on this to point at dct_finance_test).
try {
  process.loadEnvFile(path.join(REPO_ROOT, ".env"));
} catch {
  // no .env (fresh worktree, CI): fall through to defaults
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://dct:dct@localhost:5434/dct_finance",
  uploadDir: process.env.UPLOAD_DIR ?? path.join(REPO_ROOT, "data/uploads"),
  port: Number(process.env.PORT ?? 4100),
  extractionFake: process.env.EXTRACTION_FAKE === "1",
  maxUploadBytes: 50 * 1024 * 1024,
};
