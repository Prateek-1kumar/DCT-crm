import type { ModelClient } from "../agent/client";
import { priceFor, usdFor } from "../agent/cost";
import { jsonSchemaFor, parseAnswer } from "./schema";
import { ModelError, type Ask, type Reader } from "./reader";

const MAX_TOKENS = 64000;

export function claudeReader(client: ModelClient, model: string): Reader {
  const price = priceFor(model);
  return {
    model,
    async ask<T>(req: Ask<T>) {
      const response = await client.beta.messages
        .stream({
          model,
          max_tokens: MAX_TOKENS,
          system: req.system,
          messages: [
            {
              role: "user",
              content: req.parts.map((p) =>
                p.type === "text"
                  ? { type: "text" as const, text: p.text }
                  : { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: p.png.toString("base64") } },
              ),
            },
          ],
          output_config: { effort: req.effort, format: { type: "json_schema", schema: jsonSchemaFor(req.schema) } },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        })
        .finalMessage();

      const usd = usdFor(price, {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      });
      if (response.stop_reason === "refusal") throw new ModelError(`The model declined to answer "${req.name}".`, usd);
      if (response.stop_reason === "max_tokens" || response.stop_reason === "model_context_window_exceeded") {
        throw new ModelError(`The model ran out of room while answering "${req.name}", so the answer was cut off.`, usd);
      }
      const text = response.content.find((b) => b.type === "text");
      return { value: parseAnswer(req.name, text?.type === "text" ? text.text : "", req.schema, usd), model: response.model, usd };
    },
  };
}
