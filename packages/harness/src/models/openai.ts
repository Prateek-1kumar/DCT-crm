import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { openaiPrice, usdFor } from "../agent/cost";
import { jsonSchemaFor, parseAnswer } from "./schema";
import { ModelError, type Ask, type Reader } from "./reader";

const MAX_OUTPUT_TOKENS = 64000;

/** The one call the reader makes, so a test can hand in a scripted fake. The real `new OpenAI()` fits. */
export interface OpenAIClient {
  responses: { create(params: ResponseCreateParamsNonStreaming): Promise<Response> };
}

export function openaiReader(client: OpenAIClient, model: string): Reader {
  const price = openaiPrice(process.env.OPENAI_PRICE_PER_MTOK);
  return {
    model,
    async ask<T>(req: Ask<T>) {
      const response = await client.responses.create({
        model,
        instructions: req.system,
        input: [
          {
            role: "user",
            content: req.parts.map((p) =>
              p.type === "text"
                ? { type: "input_text" as const, text: p.text }
                : { type: "input_image" as const, detail: "high" as const, image_url: `data:image/png;base64,${p.png.toString("base64")}` },
            ),
          },
        ],
        text: { format: { type: "json_schema", name: req.name, strict: true, schema: jsonSchemaFor(req.schema) } },
        reasoning: req.effort ? { effort: req.effort } : undefined,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
      });

      if (!response.usage) throw new Error(`OpenAI didn't report how many tokens "${req.name}" used, so its spend can't be counted.`);
      // output_tokens already includes reasoning tokens
      const { input_tokens, output_tokens } = response.usage;
      const usd = usdFor(price, { inputTokens: input_tokens, outputTokens: output_tokens, cacheWriteTokens: 0, cacheReadTokens: 0 });
      if (response.status === "failed") throw new ModelError(`The model failed while answering "${req.name}": ${response.error?.message ?? "no reason given"}.`, usd);
      if (response.status === "incomplete") {
        const why = response.incomplete_details?.reason === "content_filter" ? "was blocked by OpenAI's content filter" : "ran out of room, so the answer was cut off";
        throw new ModelError(`The model ${why} while answering "${req.name}".`, usd);
      }
      const parts = response.output.flatMap((item) => (item.type === "message" ? item.content : []));
      if (parts.some((c) => c.type === "refusal")) throw new ModelError(`The model declined to answer "${req.name}".`, usd);
      return { value: parseAnswer(req.name, response.output_text, req.schema, usd), model: response.model, usd };
    },
  };
}
