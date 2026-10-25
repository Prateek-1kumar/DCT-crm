import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

/**
 * The model fills a compact provenance ({doc, page, loc, quote, conf}) instead of the shared
 * Provenance. The full one (method, crossCheck, nullable source…) repeated on every value makes
 * the structured-output grammar too large for the API, and those fields aren't the model's to fill.
 * `expandProv` turns the compact form back into the shared shape before zod validation.
 */
const COMPACT_PROV = {
  type: "object",
  additionalProperties: false,
  required: ["doc", "page", "loc", "quote", "conf"],
  properties: {
    doc: { type: "string", description: "documentId from the image label" },
    page: { type: "integer", description: "page number from the image label; 0 when the value is not stated anywhere" },
    loc: { type: "string", description: 'where on the page, e.g. "Exhibit A §3" or "grid row \'ECG\', column V2"; empty if page is 0' },
    quote: { type: "string", description: "short exact quote (max 25 words) for rules such as caps, deadlines and payment terms; else empty" },
    conf: { type: "number", description: "probability 0..1 that the value is exactly right" },
  },
} as const;

type Json = unknown;

const isProvenanceSchema = (n: Record<string, unknown>) => {
  const p = n.properties as Record<string, unknown> | undefined;
  return !!p && "confidence" in p && "method" in p && "crossCheck" in p;
};

function compact(node: Json): Json {
  if (Array.isArray(node)) return node.map(compact);
  if (!node || typeof node !== "object") return node;
  const n = node as Record<string, unknown>;
  if (isProvenanceSchema(n)) return { ...COMPACT_PROV, ...(n.description ? { description: n.description } : {}) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) out[k] = compact(v);
  return out;
}

/** JSON schema sent to the model for a zod schema. */
export function modelSchema(schema: z.ZodType): Record<string, unknown> {
  return compact(betaZodOutputFormat(schema).schema) as Record<string, unknown>;
}

/** Expand every compact `prov` in model output into the shared Provenance shape. */
export function expandProv(value: Json): Json {
  if (Array.isArray(value)) return value.map(expandProv);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "prov" && v && typeof v === "object" && "conf" in v) {
      const c = v as { doc?: string; page?: number; loc?: string; quote?: string; conf?: number };
      const page = Number.isInteger(c.page) && c.page! > 0 ? c.page! : 0;
      out[k] = {
        source: page
          ? { documentId: String(c.doc ?? ""), page, ...(c.loc ? { location: c.loc } : {}), ...(c.quote ? { quote: c.quote } : {}) }
          : null,
        confidence: Math.min(1, Math.max(0, Number(c.conf ?? 0))),
        method: "ai",
        crossCheck: "not_checked",
      };
    } else out[k] = expandProv(v);
  }
  return out;
}
