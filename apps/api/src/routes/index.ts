import type { FastifyInstance } from "fastify";
import type { Ctx } from "../app.js";
import { activityRoutes } from "./activity.js";
import { authRoutes } from "./auth.js";
import { readsRoutes } from "./reads.js";
import { studiesRoutes } from "./studies.js";
import { versionsRoutes } from "./versions.js";

export async function routes(api: FastifyInstance, ctx: Ctx) {
  await authRoutes(api, ctx);
  await studiesRoutes(api, ctx);
  await readsRoutes(api, ctx);
  await versionsRoutes(api, ctx);
  await activityRoutes(api, ctx);
}
