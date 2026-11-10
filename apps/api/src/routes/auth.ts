import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app.js";
import { users } from "../db/schema.js";
import { HttpError } from "../lib/http.js";
import { parse } from "../lib/parse.js";
import { checkPassword } from "../lib/password.js";

const Login = z.object({
  name: z.string({ error: "Enter your name." }).trim().toLowerCase().min(1, { error: "Enter your name." }).max(100),
  password: z.string({ error: "Enter your password." }).min(1, { error: "Enter your password." }).max(200),
});

/**
 * UAT sign-in: says whether a name and password are right; the web app keeps the session.
 * ponytail: no lockout or rate limit (a handful of generated passwords); add both with real authentication.
 */
export async function authRoutes(api: FastifyInstance, { db }: Ctx) {
  api.post("/auth/login", async (req) => {
    const { name, password } = parse(Login, req.body);
    const [user] = await db.select().from(users).where(eq(users.name, name));
    if (!(await checkPassword(password, user?.passwordHash))) throw new HttpError(401, "That name or password isn't right. Check them and try again.");
    return { name: user!.name, displayName: user!.displayName };
  });
}
