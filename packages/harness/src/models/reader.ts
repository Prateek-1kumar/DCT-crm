import type { z } from "zod";

export type Part = { type: "text"; text: string } | { type: "image"; png: Buffer };

/**
 * One structured-output call. The schema must fit both providers' strict JSON mode: objects whose fields are all
 * required (nullable instead of optional), arrays, strings, numbers, integers, booleans and enums only; no records,
 * no unions other than nullable, no min/max or pattern constraints.
 */
export interface Ask<T> {
  name: string;
  system: string;
  parts: Part[];
  schema: z.ZodType<T>;
  effort?: "low" | "medium" | "high";
}

export interface Answer<T> {
  value: T;
  model: string;
  usd: number;
}

/** A model that answers one question with JSON. Claude and OpenAI each implement it, so two reads come from different models. */
export interface Reader {
  readonly model: string;
  ask<T>(req: Ask<T>): Promise<Answer<T>>;
}

/** Spend shared by every model call in one read (§5.8). Callers check `spent < limit` before each call and add what it cost. */
export interface Budget {
  limit: number;
  spent: number;
}

/** A call that failed after the model did its work still cost money, so the error carries what to add to the budget. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly usd: number,
  ) {
    super(message);
  }
}

export const spentOn = (err: unknown) => (err instanceof ModelError ? err.usd : 0);
