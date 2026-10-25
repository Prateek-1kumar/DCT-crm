import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { describe, expect, it } from "vitest";
import { AiGrids, AiIdentify, AiPages, AiTerms, AiTermsCore, AiTermsItems, SYSTEM } from "../src/prompts";

/** Structured outputs: every object closed, no records, no numeric/string constraints. */
function problems(schema: unknown, path = "#"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Record<string, unknown>;
  const out: string[] = [];
  if (s.type === "object" && s.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`);
  for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "propertyNames", "patternProperties"])
    if (k in s) out.push(`${path}: unsupported ${k}`);
  for (const [k, v] of Object.entries(s)) {
    if (Array.isArray(v)) v.forEach((x, i) => out.push(...problems(x, `${path}/${k}/${i}`)));
    else if (typeof v === "object") out.push(...problems(v, `${path}/${k}`));
  }
  return out;
}

describe("AI schemas", () => {
  for (const [name, schema] of Object.entries({ AiPages, AiIdentify, AiTerms, AiGrids })) {
    it(`${name} converts to a structured-output-compatible JSON schema`, () => {
      expect(problems(betaZodOutputFormat(schema).schema)).toEqual([]);
    });
  }
  it("tells the model to ignore bank details", () => {
    expect(SYSTEM).toMatch(/routing/);
  });
});

describe("structured-output limits", () => {
  // Anthropic rejects schemas with more than 16 union-typed parameters (anyOf / type arrays).
  // Mocked tests can't catch this; the live API returns 400. Counted conservatively.
  const unions = (s: unknown): number => {
    if (Array.isArray(s)) return s.reduce((n: number, x) => n + unions(x), 0);
    if (!s || typeof s !== "object") return 0;
    const o = s as Record<string, unknown>;
    return (o.anyOf || Array.isArray(o.type) ? 1 : 0) + Object.values(o).reduce((n: number, v) => n + unions(v), 0);
  };
  it.each(Object.entries({ AiPages, AiIdentify, AiTermsCore, AiTermsItems, AiGrids }))("%s has at most 16 union parameters", (_, schema) => {
    expect(unions(betaZodOutputFormat(schema).schema)).toBeLessThanOrEqual(16);
  });
});
