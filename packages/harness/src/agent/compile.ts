import { Rulebook } from "@dct/shared";
import { checks } from "../checks";
import type { CheckReport, LoadedDoc } from "../types";
import type { ModelClient, ModelMessage, ModelParams } from "./client";
import { priceFor, usdFor, type Usage } from "./cost";
import { OCR_NOTE, SYSTEM_PROMPT } from "./prompt";
import { createSession } from "./session";
import { TOOLS } from "./tools";

export interface CompileOptions {
  client: ModelClient;
  model?: string;
  maxUsd?: number;
  maxTurns?: number;
  maxFinishes?: number;
  onProgress?: (line: string) => void;
}

export interface TraceTurn {
  turn: number;
  model: string;
  usage: Usage;
  usd: number;
  toolCalls: { name: string; input: unknown; resultSummary: string }[];
  stopReason: string | null;
}

export type StopReason = "done" | "finishes_exhausted" | "budget" | "max_turns" | "refusal" | "max_tokens" | "model_context_window_exceeded" | "error";

export interface CompileResult {
  rulebook: Rulebook;
  report: CheckReport;
  model: string;
  usd: number;
  turns: number;
  finishes: number;
  stopReason: StopReason;
  trace: TraceTurn[];
  /** Why the model call itself failed; the rulebook is then whatever was written before. */
  error?: string;
}

const MAX_TOKENS = 64000;
const CUT_OFF = ["refusal", "max_tokens", "model_context_window_exceeded"] as const;

const KIND_NOTE = { text: "TEXT", scan: OCR_NOTE, image: "IMAGE (use view_page)" };

function inventory(docs: LoadedDoc[]): string {
  return docs
    .map((d) => {
      const pages = d.pages.map((p) => `p${p.page}: ${KIND_NOTE[p.kind]}, ${p.raw.length} chars | ${p.firstLine}`);
      return [`## ${d.name} (${d.pages.length} pages)`, ...pages].join("\n");
    })
    .join("\n\n");
}

export async function compile(docs: LoadedDoc[], opts: CompileOptions): Promise<CompileResult> {
  const model = opts.model ?? process.env.HARNESS_MODEL ?? "claude-sonnet-5-5";
  const envUsd = Number(process.env.HARNESS_MAX_USD);
  const maxUsd = opts.maxUsd ?? (envUsd > 0 ? envUsd : 3);
  const maxTurns = opts.maxTurns ?? 80;
  const maxFinishes = opts.maxFinishes ?? 3;
  const say = opts.onProgress ?? (() => {});
  const price = priceFor(model);

  const session = createSession(docs, maxFinishes);
  const messages: ModelParams["messages"] = [{ role: "user", content: `Compile the rulebook for this study. Document inventory:\n\n${inventory(docs)}` }];
  const trace: TraceTurn[] = [];
  let usd = 0;
  let stopReason: StopReason = "max_turns";
  let error: string | undefined;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (usd >= maxUsd) {
      stopReason = "budget";
      say(`Stopped at the $${maxUsd.toFixed(2)} spending limit`);
      break;
    }

    let response: ModelMessage;
    try {
      response = await opts.client.beta.messages
        .stream({
          model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages,
          output_config: { effort: "high" },
          cache_control: { type: "ephemeral" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        })
        .finalMessage();
    } catch (err) {
      stopReason = "error";
      error = err instanceof Error ? err.message : String(err);
      say(`The model call failed: ${error}`);
      break;
    }

    const usage: Usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const turnUsd = usdFor(price, usage);
    usd += turnUsd;
    const entry: TraceTurn = { turn, model: response.model, usage, usd: turnUsd, toolCalls: [], stopReason: response.stop_reason };
    trace.push(entry);
    messages.push({ role: "assistant", content: response.content });

    const cutOff = CUT_OFF.find((r) => r === response.stop_reason);
    if (cutOff) {
      stopReason = cutOff;
      say(`Stopped: the model ended its turn early (${cutOff})`);
      break;
    }

    const calls = response.content.filter((b) => b.type === "tool_use");
    if (!calls.length) {
      messages.push({ role: "user", content: "Continue: write the rulebook with the put_* tools and call finish." });
      continue;
    }

    const results = [];
    for (const call of calls) {
      const outcome = await session.run(call.name, call.input);
      say(outcome.progress);
      entry.toolCalls.push({ name: call.name, input: call.input, resultSummary: outcome.summary });
      results.push({ type: "tool_result" as const, tool_use_id: call.id, content: outcome.content, is_error: outcome.isError });
    }
    messages.push({ role: "user", content: results });

    if (session.state.ending) {
      stopReason = session.state.ending;
      break;
    }
  }

  const draft = session.rulebook();
  const report = checks.runChecks(draft, docs);
  const known = new Set(draft.questions.map((q) => q.id));
  const rulebook = Rulebook.parse({ ...draft, questions: [...draft.questions, ...report.required.filter((q) => !known.has(q.id))] });
  return { rulebook, report, model, usd, turns: trace.length, finishes: session.state.finishes, stopReason, trace, ...(error && { error }) };
}
