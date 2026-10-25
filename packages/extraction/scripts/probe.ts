/**
 * Cheap live check that every model schema compiles on the provider (no images, tiny prompt).
 * Structured-output limits (union count, grammar size) are only enforced by the live API.
 *   pnpm --filter @dct/extraction probe
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropicClient, DEFAULT_FAST_MODEL, openaiClient, type LlmClient } from "../src/llm";
import { AiGrids, AiIdentify, AiPages, AiTermsItems, AiTermsPayment, AiTermsStudy } from "../src/prompts";

const root = process.env.DCT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));

const clients: LlmClient[] = [];
if (process.env.ANTHROPIC_API_KEY) clients.push(anthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY }));
if (process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) clients.push(openaiClient({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }));
if (!clients.length) {
  console.log("No API keys; probe skipped.");
  process.exit(0);
}

const schemas = { AiPages, AiIdentify, AiTermsItems, AiTermsPayment, AiTermsStudy, AiGrids };
// Page sorting and identify run on the fast model (Haiku).
if (process.env.ANTHROPIC_API_KEY) clients.push(anthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_FAST_MODEL || DEFAULT_FAST_MODEL }));
let failed = 0;
for (const llm of clients) {
  const isFast = llm.model.includes("haiku");
  for (const [name, schema] of Object.entries(schemas)) {
    if (isFast && name !== "AiPages" && name !== "AiIdentify") continue;
    try {
      await llm.call({
        name: `probe-${name}`,
        system: "You are testing a JSON schema.",
        prompt: "There is no document. Return the smallest valid object: empty arrays, nulls, \"unspecified\"/\"none\" where offered, page 0 and conf 0 in every prov.",
        images: [],
        schema,
        effort: "low",
      });
      console.log(`ok    ${llm.model.padEnd(18)} ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${llm.model.padEnd(18)} ${name}: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  console.log(`cost  ${llm.model}: $${llm.cost().usd}`);
}
process.exit(failed ? 1 : 0);
