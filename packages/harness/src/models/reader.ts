import type { z } from "zod";
import type { Price } from "../agent/cost";

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
  readonly price: Price;
  ask<T>(req: Ask<T>): Promise<Answer<T>>;
}

/** Spend shared by every model call in one read (§5.8). A call starts only if its estimate fits, and then adds what it cost. */
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

// ponytail: ~3.5 characters a token and ~1,600 tokens a page image; replace with the providers' token counting if estimates drift.
const CHARS_PER_TOKEN = 3.5;
const IMAGE_TOKENS = 1600;

export function estimateUsd(reader: Reader, parts: Part[], outputTokens: number): number {
  const input = parts.reduce((n, p) => n + (p.type === "text" ? p.text.length / CHARS_PER_TOKEN : IMAGE_TOKENS), 0);
  return (input * reader.price.input + outputTokens * reader.price.output) / 1e6;
}
