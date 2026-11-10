import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;
/** Checked against when the name is unknown, so a wrong name takes as long as a wrong password. */
const NOBODY = `${"A".repeat(22)}.${"A".repeat(43)}`;

/** "salt.hash" (scrypt, Node's own: no extra package). */
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `${salt.toString("base64url")}.${(await derive(password, salt, 32)).toString("base64url")}`;
}

export async function checkPassword(password: string, stored: string | undefined) {
  const [salt, hash] = (stored ?? NOBODY).split(".") as [string, string];
  const same = timingSafeEqual(await derive(password, Buffer.from(salt, "base64url"), 32), Buffer.from(hash, "base64url"));
  return stored !== undefined && same;
}
