import type { z } from "zod";
import { HttpError } from "./http.js";

/** `data` checked against `schema`; the first problem becomes a 400, so schemas carry plain-English messages. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  throw new HttpError(400, issue.path.length ? issue.message : "The request is missing its details.");
}
