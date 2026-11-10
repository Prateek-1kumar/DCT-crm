/** The one way the web talks to the API; screens add their own typed calls on top of `request`. */

/** Every route of the real API is under /api/v1 (the Next rewrite forwards /api/* as is). */
const BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The API's x-request-id, so the team can find the failed request in its log. */
    public requestId?: string,
  ) {
    super(message);
  }
}

type Body = Record<string, unknown> | FormData | undefined;

/** A fresh key per write; `crypto.randomUUID` needs a secure context (localhost is one), hence the fallback. */
const newKey = () => crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
/** Waits before each retry of a write whose answer never arrived. */
const RETRY_MS = [500, 1500];

/** Writes still waiting for their answer, by what they send. */
const inflight = new Map<string, Promise<unknown>>();
const bodyKey = (body: Body) =>
  body instanceof FormData
    ? [...body.entries()].map(([k, v]) => `${k}=${typeof v === "string" ? v : `${v.name}:${v.size}:${v.lastModified}`}`).join("&")
    : JSON.stringify(body ?? null);

/**
 * Every write is one user action with one Idempotency-Key. The same write again while the first is still waiting (a
 * double click, Enter pressed twice: the button disables only once React re-renders) is that same action: it shares the
 * first one's request and answer, so it can't apply twice. Once the answer is in, the same write is a new action.
 */
export function request<T>(method: string, path: string, body?: Body): Promise<T> {
  if (method === "GET") return send<T>(method, path, body);
  const same = `${method} ${path} ${bodyKey(body)}`;
  let p = inflight.get(same) as Promise<T> | undefined;
  if (!p) {
    p = send<T>(method, path, body, newKey()).finally(() => inflight.delete(same));
    inflight.set(same, p);
  }
  return p;
}

/**
 * The key is made once per action and sent again on each retry. A write whose answer was lost or that failed on the
 * server's side (no answer: the network dropped; a 5xx: the API was restarting, or the proxy couldn't reach it) is
 * retried with the same key: the API applies it once and hands back its first answer, and a write that failed saved
 * nothing, so running it again is safe.
 */
async function send<T>(method: string, path: string, body: Body, key?: string): Promise<T> {
  const headers: Record<string, string> = key ? { "idempotency-key": `"${key}"` } : {};
  const init: RequestInit = { method, headers };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  let res: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    const retry = key !== undefined && attempt < RETRY_MS.length;
    try {
      res = await fetch(`${BASE}${path}`, init);
      if (!retry || ![500, 502, 503, 504].includes(res.status)) break;
    } catch {
      if (!retry) throw new ApiError(0, "Can't reach DCT Finance right now. Check your connection, then try again.");
    }
    await new Promise((r) => setTimeout(r, RETRY_MS[attempt]));
  }
  const text = await res.text();
  const json: unknown = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, errorMessage(json, res.status), res.headers.get("x-request-id") ?? undefined);
  return json as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/** Accepts Fastify's `{ message }`, `{ error }`, or a bare string. */
function errorMessage(json: unknown, status: number): string {
  if (typeof json === "string" && json) return json;
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    for (const k of ["message", "error"]) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  }
  return status >= 500 ? "Something went wrong on the server. Try again; if it keeps happening, tell the team." : "That didn't go through. Try again.";
}
