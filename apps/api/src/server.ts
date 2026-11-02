import { buildApp } from "./app.js";
import { config, readingProblem } from "./config.js";

// This server runs the reading (its job workers), so it needs the AI key: fail fast, before anything listens.
const problem = readingProblem();
if (problem) {
  console.error(problem);
  process.exit(1);
}
const { app } = await buildApp({ logger: true });
await app.listen({ port: config.port, host: config.listenHost });

/**
 * SIGTERM / SIGINT: stop taking requests (new ones get 503, readiness too), let in-flight requests finish, then the jobs
 * (pg-boss, up to its own limit), then close the pool (app.ts onClose). Past SHUTDOWN_TIMEOUT_MS, or on a second
 * signal, exit anyway: a read still running is failed by pg-boss and marked so at the next start.
 */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) {
    app.log.warn({ signal }, "second signal: exiting now");
    process.exit(1);
  }
  stopping = true;
  app.log.info({ signal }, "shutting down");
  setTimeout(() => {
    app.log.error({ timeoutMs: config.shutdownTimeoutMs }, "shutdown took too long: exiting");
    process.exit(1);
  }, config.shutdownTimeoutMs).unref();
  try {
    await app.close();
    app.log.info("shut down");
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "shutdown failed");
    process.exit(1);
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, (s) => void shutdown(String(s)));
