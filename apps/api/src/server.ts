import { buildApp } from "./app.js";
import { config } from "./config.js";

const { app } = await buildApp({ logger: true });
await app.listen({ port: config.port, host: config.listenHost });
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => void app.close().then(() => process.exit(0)));
