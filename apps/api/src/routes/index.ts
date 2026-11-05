import type { FastifyInstance } from "fastify";
import type { Ctx } from "../app.js";
import { readsRoutes } from "./reads.js";
import { studiesRoutes } from "./studies.js";
import { versionsRoutes } from "./versions.js";

export async function routes(api: FastifyInstance, ctx: Ctx) {
  await studiesRoutes(api, ctx);
  await readsRoutes(api, ctx);
  await versionsRoutes(api, ctx);
}
