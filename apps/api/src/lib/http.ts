import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);

/** Validate with a shared zod schema; 400 with readable issues on failure. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, z.prettifyError(r.error));
  return r.data;
}

export const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The words of a search, for matching every one. */
export const wordsOf = (q = "") => q.trim().split(/\s+/).filter(Boolean);
/** An ILIKE pattern for `w` anywhere, its wildcards taken literally. */
export const like = (w: string) => `%${w.replace(/[\\%_]/g, "\\$&")}%`;
