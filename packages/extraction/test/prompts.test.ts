import { expandProv, modelSchema } from "../src/model-schema";
import { describe, expect, it } from "vitest";
import { AiGrids, AiIdentify, AiPages, AiTerms, AiTermsItems, AiTermsPayment, AiTermsStudy, SYSTEM } from "../src/prompts";

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
      expect(problems(modelSchema(schema))).toEqual([]);
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
  it.each(Object.entries({ AiPages, AiIdentify, AiTermsItems, AiTermsPayment, AiTermsStudy, AiGrids }))("%s has at most 16 union parameters", (_, schema) => {
    expect(unions(modelSchema(schema))).toBeLessThanOrEqual(16);
  });
});

describe("compact provenance", () => {
  it("replaces every Provenance in the model schema", () => {
    const s = JSON.stringify(modelSchema(AiTermsStudy));
    expect(s).not.toContain("crossCheck");
    expect(s).toContain('"conf"');
  });
  it("expands model output to the shared shape; page 0 means not stated", () => {
    expect(expandProv({ a: { value: 45, prov: { doc: "d1", page: 3, loc: "§4", quote: "within forty-five (45) days", conf: 1.2 } } })).toEqual({
      a: { value: 45, prov: { source: { documentId: "d1", page: 3, location: "§4", quote: "within forty-five (45) days" }, confidence: 1, method: "ai", crossCheck: "not_checked" } },
    });
    expect(expandProv([{ prov: { doc: "", page: 0, loc: "", quote: "", conf: 0.1 } }])).toEqual([
      { prov: { source: null, confidence: 0.1, method: "ai", crossCheck: "not_checked" } },
    ]);
  });
});
