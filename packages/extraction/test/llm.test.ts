import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/** The Anthropic SDK stand-in: each call to the model returns the next queued message. */
const replies: { text: string; stop?: string }[] = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = {
      messages: {
        stream: () => ({
          finalMessage: async () => {
            const r = replies.shift()!;
            return { content: [{ type: "text", text: r.text }], stop_reason: r.stop ?? "end_turn", usage: { input_tokens: 1000, output_tokens: 100 } };
          },
        }),
      },
    };
  },
}));

const { anthropicClient } = await import("../src/llm");
const Schema = z.object({ n: z.number() });
const ask = (llm: ReturnType<typeof anthropicClient>) => llm.call({ name: "terms", system: "", prompt: "", images: [], schema: Schema });

describe("model replies (the only way model output gets in)", () => {
  beforeEach(() => void (replies.length = 0));

  it("are parsed with the schema; one bad reply is asked again, and both are paid for", async () => {
    const llm = anthropicClient({ apiKey: "test", model: "claude-sonnet-5-5" });
    replies.push({ text: '{"n": "seven"}' }, { text: '{"n": 7}' });
    expect(await ask(llm)).toEqual({ n: 7 });
    expect(llm.cost()).toMatchObject({ inputTokens: 2000, outputTokens: 200, usd: 0.006 });
  });

  it("fail after two replies that don't fit, or one that isn't JSON then one that doesn't fit", async () => {
    const llm = anthropicClient({ apiKey: "test" });
    replies.push({ text: "not json" }, { text: '{"m": 1}' });
    await expect(ask(llm)).rejects.toThrow(/The AI's answer for "terms" didn't have the expected shape, twice/);
    expect(replies).toEqual([]);
  });

  it("fail on a refusal or a reply cut off at its length limit, never parsed as a partial answer", async () => {
    const llm = anthropicClient({ apiKey: "test" });
    replies.push({ text: '{"n": 1}', stop: "refusal" });
    await expect(ask(llm)).rejects.toThrow(/declined to read "terms"/);
    replies.push({ text: '{"n": 1}', stop: "max_tokens" });
    await expect(ask(llm)).rejects.toThrow(/cut off at its length limit/);
  });
});
