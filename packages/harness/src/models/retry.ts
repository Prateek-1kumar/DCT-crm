const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "UND_ERR_SOCKET", "UND_ERR_BODY_TIMEOUT"]);

/** A dropped connection or an overloaded provider, as opposed to a request the provider rejected. */
export function isDropped(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { status?: number; code?: string; cause?: { code?: string } };
  if (e.name === "APIConnectionError" || e.name === "APIConnectionTimeoutError") return true;
  if (typeof e.status === "number") return e.status >= 500 || e.status === 429 || e.status === 408;
  if (NETWORK_CODES.has(e.code ?? "") || NETWORK_CODES.has(e.cause?.code ?? "")) return true;
  return e instanceof TypeError && /^(terminated|fetch failed)$/.test(e.message);
}

/** The SDKs retry a request that never started; a stream cut mid-answer reaches us as an error, and losing the whole read to it is worse than asking again. */
export async function retryDropped<T>(call: () => Promise<T>, waitsMs: readonly number[] = [2000, 8000]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= waitsMs.length || !isDropped(err)) throw err;
      await new Promise((r) => setTimeout(r, waitsMs[attempt]));
    }
  }
}
