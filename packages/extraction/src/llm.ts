import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { expandProv, modelSchema } from "./model-schema";

/** Every model call goes through here: provider + model from config, timeouts, retries, usage/cost. */

export type Image = { label: string; png: Buffer };

export type LlmRequest<T> = {
  name: string;
  system: string;
  prompt: string;
  images: Image[];
  schema: z.ZodType<T>;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Cache the images (Anthropic prompt caching): later calls with the same system + images pay ~10% for them. */
  cacheImages?: boolean;
};

export type CostEntry = { provider: "anthropic" | "openai"; model: string; inputTokens: number; outputTokens: number; usd: number };

export interface LlmClient {
  provider: CostEntry["provider"];
  model: string;
  call<T>(req: LlmRequest<T>): Promise<T>;
  cost(): CostEntry;
}

export class LlmError extends Error {}

const TIMEOUT_MS = 15 * 60 * 1000;
const MAX_RETRIES = 3;

/** USD per million tokens. ponytail: fallback-model hops are priced at the primary's rate. */
const ANTHROPIC_PRICES: Record<string, { in: number; out: number; cacheWrite: number; cacheRead: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  // ponytail: Haiku 5.5 prompts over 100K tokens cost more; page sorting stays far below that.
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-opus-5-5": { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.2 },
};

/** Defaults (user decision 2026-10-26): no Opus. Sonnet reads, Haiku sorts pages. Override via env. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_FAST_MODEL = "claude-haiku-5-5";

/** Model output is JSON text; validate it, and retry once on a bad parse (usage of both attempts is counted). */
async function withParseRetry<T>(name: string, schema: z.ZodType<T>, attempt: () => Promise<string>): Promise<T> {
  let lastErr = "";
  for (let i = 0; i < 2; i++) {
    const text = await attempt();
    try {
      const r = schema.safeParse(expandProv(JSON.parse(text)));
      if (r.success) return r.data;
      lastErr = z.prettifyError(r.error).slice(0, 2000);
    } catch (e) {
      lastErr = `invalid JSON: ${(e as Error).message}`;
    }
  }
  throw new LlmError(`${name}: model output did not match the schema: ${lastErr}`);
}

export function anthropicClient(opts: { apiKey: string; model?: string }): LlmClient {
  const model = opts.model ?? DEFAULT_MODEL;
  // Haiku has no server-side refusal fallback; only send the fallback beta where it exists.
  const fallback = model.includes("haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };
  const client = new Anthropic({ apiKey: opts.apiKey, timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES });
  const usage = { input: 0, output: 0, usd: 0 };
  const price = ANTHROPIC_PRICES[model];
  return {
    provider: "anthropic",
    model,
    cost: () => ({ provider: "anthropic", model, inputTokens: usage.input, outputTokens: usage.output, usd: round(usage.usd) }),
    async call<T>(req: LlmRequest<T>) {
      // Plain JSON-schema format (not the auto-parsing one) so a bad parse doesn't lose the usage numbers.
      const format = { type: "json_schema" as const, schema: modelSchema(req.schema) };
      const content: Anthropic.Beta.BetaContentBlockParam[] = req.images.flatMap((img, i) => [
        { type: "text" as const, text: img.label },
        {
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/png" as const, data: img.png.toString("base64") },
          ...(req.cacheImages && i === req.images.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
        },
      ]);
      content.push({ type: "text", text: req.prompt });
      return withParseRetry(req.name, req.schema, async () => {
        const msg = await client.beta.messages
          .stream({
            model,
            // 128K needs streaming (we stream); max-effort grid re-reads can think at length.
            max_tokens: 128000,
            ...fallback,
            thinking: { type: "adaptive" },
            output_config: { effort: req.effort ?? "high", format },
            system: req.system,
            messages: [{ role: "user", content }],
          })
          .finalMessage();
        const u = msg.usage;
        const cacheW = u.cache_creation_input_tokens ?? 0;
        const cacheR = u.cache_read_input_tokens ?? 0;
        usage.input += u.input_tokens + cacheW + cacheR;
        usage.output += u.output_tokens;
        if (price) usage.usd += (u.input_tokens * price.in + cacheW * price.cacheWrite + cacheR * price.cacheRead + u.output_tokens * price.out) / 1e6;
        if (msg.stop_reason === "refusal") throw new LlmError(`${req.name}: model refused (${msg.stop_details?.category ?? "no category"}) even after fallback`);
        if (msg.stop_reason === "max_tokens") throw new LlmError(`${req.name}: output hit max_tokens`);
        return msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      });
    },
  };
}

/**
 * OpenAI cross-read. Model comes from OPENAI_MODEL (never guessed). Price per million tokens from
 * OPENAI_PRICE_PER_MTOK="input,output"; usd is 0 when unset.
 */
export function openaiClient(opts: { apiKey: string; model: string; pricePerMTok?: string }): LlmClient {
  const { model } = opts;
  const client = new OpenAI({ apiKey: opts.apiKey, timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES });
  const [pin, pout] = (opts.pricePerMTok ?? "").split(",").map(Number);
  const usage = { input: 0, output: 0 };
  return {
    provider: "openai",
    model,
    cost: () => ({
      provider: "openai",
      model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      usd: pin && pout ? round((usage.input * pin + usage.output * pout) / 1e6) : 0,
    }),
    async call<T>(req: LlmRequest<T>) {
      const schema = modelSchema(req.schema);
      const content: OpenAI.Responses.ResponseInputContent[] = req.images.flatMap((img) => [
        { type: "input_text" as const, text: img.label },
        { type: "input_image" as const, detail: "high" as const, image_url: `data:image/png;base64,${img.png.toString("base64")}` },
      ]);
      content.push({ type: "input_text", text: req.prompt });
      return withParseRetry(req.name, req.schema, async () => {
        const res = await client.responses.create({
          model,
          instructions: req.system,
          input: [{ role: "user", content }],
          // strict:false — the shared schemas use optional fields, which strict mode forbids; zod validates instead.
          text: { format: { type: "json_schema", name: req.name.replace(/[^a-zA-Z0-9_-]/g, "_"), schema, strict: false } },
        });
        usage.input += res.usage?.input_tokens ?? 0;
        usage.output += res.usage?.output_tokens ?? 0;
        if (res.status === "incomplete") throw new LlmError(`${req.name}: OpenAI response incomplete (${res.incomplete_details?.reason ?? "unknown"})`);
        return res.output_text;
      });
    },
  };
}

const round = (usd: number) => Math.round(usd * 10000) / 10000;

/** Build clients from env. Missing key/model → null (caller decides whether that's fatal). */
export function clientsFromEnv(env: NodeJS.ProcessEnv = process.env): { primary: LlmClient | null; fast: LlmClient | null; cross: LlmClient | null } {
  return {
    primary: env.ANTHROPIC_API_KEY ? anthropicClient({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || undefined }) : null,
    fast: env.ANTHROPIC_API_KEY ? anthropicClient({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_FAST_MODEL || DEFAULT_FAST_MODEL }) : null,
    cross:
      env.OPENAI_API_KEY && env.OPENAI_MODEL
        ? openaiClient({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL, pricePerMTok: env.OPENAI_PRICE_PER_MTOK })
        : null,
  };
}
