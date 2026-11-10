// UAT sign-in accounts. Run against whichever database DATABASE_URL names (the hosted one, from the host).
//   pnpm --filter @dct/api user:add <name> "<Display Name>"   makes the account and prints a password, once
//   pnpm --filter @dct/api user:reset <name>                  prints a new password
//   pnpm --filter @dct/api user:remove <name>
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/index.js";
import { users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

const [cmd, rawName, ...rest] = process.argv.slice(2);
const name = rawName?.trim().toLowerCase();
const display = rest.join(" ").trim();
const usage = 'Usage: user:add <name> "<Display Name>" | user:reset <name> | user:remove <name>';
if (!name || !["add", "reset", "remove"].includes(cmd ?? "") || (cmd === "add" && !display)) {
  console.error(usage);
  process.exit(1);
}

const { db, pool } = createDb();
// a password nobody has to invent: 16 random characters, shown once
const password = randomBytes(12).toString("base64url");
const [existing] = await db.select().from(users).where(eq(users.name, name));
if (cmd === "add") {
  if (existing) throw new Error(`"${name}" already has an account. Use user:reset to give them a new password.`);
  await db.insert(users).values({ name, displayName: display, passwordHash: await hashPassword(password) });
  console.log(`Created ${name} (${display}).\nPassword: ${password}`);
} else if (!existing) {
  throw new Error(`There's no account called "${name}".`);
} else if (cmd === "reset") {
  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.name, name));
  console.log(`New password for ${name}: ${password}`);
} else {
  await db.delete(users).where(eq(users.name, name));
  console.log(`Removed ${name}.`);
}
await pool.end();
