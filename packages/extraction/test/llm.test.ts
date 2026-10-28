import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/** The Anthropic SDK stand-in: each call to the model returns the next queued message. */
const replies: { text: string; stop?: string }[] = [];
/** What each request was sent with: its body and its request options. */
const sent: { params: { output_config?: { format: object } }; options?: { signal?: AbortSignal } }[] = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = {
      messages: {
        stream: (params: (typeof sent)[number]["params"], options: (typeof sent)[number]["options"]) => (sent.push({ params, options }), {
          finalMessage: async () => {
            const r = replies.shift()!;
            return { content: [{ type: "text", text: r.text }], stop_reason: r.stop ?? "end_turn", usage: { input_tokens: 1000, output_tokens: 100 } };
          },
        }),
      },
    };
  },
}));
vi.mock("openai", () => ({
  default: class {
    responses = { create: async (params: (typeof sent)[number]["params"], options: (typeof sent)[number]["options"]) => (sent.push({ params, options }), { status: "completed", output_text: '{"n": 1}', usage: { input_tokens: 10, output_tokens: 1 } }) };
  },
}));

const { anthropicClient, openaiClient } = await import("../src/llm");
const Schema = z.object({ n: z.number() });
const ask = (llm: ReturnType<typeof anthropicClient>) => llm.call({ name: "terms", system: "", prompt: "", images: [], schema: Schema });

describe("model replies (the only way model output gets in)", () => {
  beforeEach(() => void (replies.length = 0, sent.length = 0));

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

  it("never quote the reply in their errors (a job's detail, a reading's warnings): a reply that isn't JSON is named by its error's class and where it broke", async () => {
    const llm = anthropicClient({ apiKey: "test" });
    const why = (r: Promise<unknown>) => r.then(() => "", (e: Error) => e.message);
    replies.push({ text: "Payee Acme Bank, account 12345678" }, { text: '{"n": 1, "payee": "Acme Bank, account 12345678' });
    const cut = await why(ask(llm)); // "Unterminated string in JSON at position 13 …"
    replies.push({ text: "Payee Acme Bank, account 12345678" }, { text: "Payee Acme Bank, account 12345678" });
    const prose = await why(ask(llm)); // V8: "Unexpected token 'P', "Payee Acme"... is not valid JSON"
    replies.push({ text: '{"n": "Acme Bank, account 12345678"}' }, { text: '{"n": "Acme Bank, account 12345678"}' });
    const misfit = await why(ask(llm));
    expect(cut).toMatch(/: not JSON \(SyntaxError at position \d+\)$/);
    expect(prose).toMatch(/: not JSON \(SyntaxError\)$/);
    expect(misfit).toMatch(/expected number, received string/);
    for (const m of [cut, prose, misfit]) expect(m).not.toMatch(/Acme|1234|Payee/);
    // The SDK's own parse would quote it ("Failed to parse structured output: SyntaxError: …"): it's never asked to.
    expect(sent.every((r) => !("parse" in r.params.output_config!.format))).toBe(true);
  });

  it("hand the read's abort signal to each request, so one in flight is cancelled", async () => {
    const stop = new AbortController();
    replies.push({ text: '{"n": 1}' });
    await anthropicClient({ apiKey: "test" }).call({ name: "terms", system: "", prompt: "", images: [], schema: Schema, signal: stop.signal });
    await openaiClient({ apiKey: "test", model: "gpt-test" }).call({ name: "terms", system: "", prompt: "", images: [], schema: Schema, signal: stop.signal });
    expect(sent.map((r) => r.options?.signal)).toEqual([stop.signal, stop.signal]);
  });

  it("fail on a refusal or a reply cut off at its length limit, never parsed as a partial answer", async () => {
    const llm = anthropicClient({ apiKey: "test" });
    replies.push({ text: '{"n": 1}', stop: "refusal" });
    await expect(ask(llm)).rejects.toThrow(/declined to read "terms"/);
    replies.push({ text: '{"n": 1}', stop: "max_tokens" });
    await expect(ask(llm)).rejects.toThrow(/cut off at its length limit/);
  });
});

// ADR-001 §9: contracts reach a model only through this package, so no other code may import a model SDK.
describe("model SDKs", () => {
  it("are imported nowhere outside packages/extraction", () => {
    const repo = join(import.meta.dirname, "../../..");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.[cm]?[jt]sx?$/.test(e.name) ? [join(dir, e.name)] : []));
    const roots = [...readdirSync(join(repo, "apps")).map((a) => join(repo, "apps", a, "src")), join(repo, "packages/shared/src")];
    expect(roots.length).toBeGreaterThan(2);
    const sdk = /(?:from|import|require)\s*\(?\s*["'](?:@anthropic-ai\/sdk|openai)(?:\/[^"']*)?["']/;
    expect(roots.flatMap(files).filter((f) => sdk.test(readFileSync(f, "utf8"))).map((f) => f.slice(repo.length + 1))).toEqual([]);
  });
});
