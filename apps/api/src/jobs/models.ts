import Anthropic from "@anthropic-ai/sdk";
import { claudeReader, openaiReader, type ModelClient, type Reader } from "@dct/harness";
import OpenAI from "openai";
import { config } from "../config.js";
import { HttpError } from "../lib/http.js";

export interface Models {
  anthropic: ModelClient;
  claude: Reader;
  openai: Reader;
}

const missing = (what: string, name: string) => new HttpError(503, `Reading isn't set up yet: ${what} is missing. Add ${name} to .env and restart.`);

/** Real clients from the settings; a plain 503 naming whatever is missing, never a key. */
export function modelsFromConfig(): Models {
  const { anthropicKey, openaiKey, claudeModel, openaiModel, openaiPrice } = config.ai;
  if (!anthropicKey) throw missing("the Anthropic key", "ANTHROPIC_API_KEY");
  if (!openaiKey) throw missing("the OpenAI key", "OPENAI_API_KEY");
  if (!openaiModel) throw missing("the OpenAI model name", "OPENAI_MODEL");
  if (!openaiPrice) throw missing("the OpenAI price", "OPENAI_PRICE_PER_MTOK");
  try {
    const anthropic = new Anthropic({ apiKey: anthropicKey });
    // the harness reads OPENAI_PRICE_PER_MTOK from the environment itself; its messages are plain English
    return { anthropic, claude: claudeReader(anthropic, claudeModel), openai: openaiReader(new OpenAI({ apiKey: openaiKey }), openaiModel) };
  } catch (err) {
    throw new HttpError(503, `Reading isn't set up correctly: ${(err as Error).message}`);
  }
}
