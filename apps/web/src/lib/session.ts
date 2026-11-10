/**
 * UAT sign-in session: one signed cookie. The API checks the password (users table); this only signs and reads the
 * cookie. Off unless AUTH_REQUIRED=1, so dev and the browser tests run as before. Replaced by real authentication.
 * ponytail: one secret, no server-side session list (so no remote sign-out); revisit with real authentication.
 */
export const COOKIE = "dct_session";
/** Readable by the page (not httpOnly): the signed-in person's display name, which signs their work. */
export const NAME_COOKIE = "dct_user";
const DAY = 24 * 60 * 60;
export const MAX_AGE = 7 * DAY;

export const authRequired = (env = process.env) => env.AUTH_REQUIRED === "1";

async function mac(data: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))).toString("base64url");
}

export async function sign(user: string, secret: string, now = Date.now()) {
  const body = `${Buffer.from(user).toString("base64url")}.${Math.floor(now / 1000) + MAX_AGE}`;
  return `${body}.${await mac(body, secret)}`;
}

/** The signed-in user's name, or null for a missing, forged or expired cookie (or no secret set: nobody gets in). */
export async function verify(token: string | undefined, secret: string | undefined, now = Date.now()) {
  const [user, exp, sig] = token?.split(".") ?? [];
  if (!secret || !user || !exp || !sig || Number(exp) * 1000 < now) return null;
  const want = await mac(`${user}.${exp}`, secret);
  // compare without an early exit
  let diff = want.length ^ sig.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? Buffer.from(user, "base64url").toString() : null;
}
