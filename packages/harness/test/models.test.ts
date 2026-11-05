import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openaiPrice } from "../src/agent/cost";
import type { ModelClient, ModelMessage, ModelParams } from "../src/agent/client";
import { claudeReader, openaiReader, spentOn, type Ask, type OpenAIClient } from "../src/models";
import { jsonSchemaFor } from "../src/models/schema";

const Fee = z.object({ name: z.string(), cents: z.number().int(), note: z.string().nullable(), tags: z.array(z.object({ label: z.string() })) });
type Fee = z.infer<typeof Fee>;
const GOOD: Fee = { name: "Startup", cents: 123456, note: null, tags: [{ label: "once" }] };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const ask: Ask<Fee> = {
  name: "read_fee",
  system: "Read the fee.",
  parts: [{ type: "text", text: "Page 3" }, { type: "image", png: PNG }],
  schema: Fee,
  effort: "high",
};

const claudeMessage = (over: Record<string, unknown> = {}, text = JSON.stringify(GOOD)) =>
  ({
    id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text }], stop_reason: "end_turn",
    usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...over,
  }) as unknown as ModelMessage;

function fakeClaude(message: ModelMessage) {
  const seen: ModelParams[] = [];
  const client: ModelClient = { beta: { messages: { stream: (params) => (seen.push(params), { finalMessage: () => Promise.resolve(message) }) } } };
  return { client, seen };
}

type OpenAIResponse = Awaited<ReturnType<ReturnType<OpenAIClient["responses"]["stream"]>["finalResponse"]>>;

const openaiResponse = (over: Record<string, unknown> = {}) =>
  ({
    id: "resp", model: "gpt-5.5", status: "completed", error: null, incomplete_details: null,
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(GOOD) }] }],
    output_text: JSON.stringify(GOOD),
    usage: { input_tokens: 2000, output_tokens: 1000, input_tokens_details: { cached_tokens: 500 }, output_tokens_details: { reasoning_tokens: 700 } },
    ...over,
  }) as unknown as OpenAIResponse;

function fakeOpenAI(response: OpenAIResponse) {
  const seen: Parameters<OpenAIClient["responses"]["stream"]>[0][] = [];
  const client: OpenAIClient = { responses: { stream: (params) => (seen.push(params), { finalResponse: () => Promise.resolve(response) }) } };
  return { client, seen };
}

afterEach(() => vi.unstubAllEnvs());

describe("the real SDK clients fit the narrow client types", () => {
  it("compiles", () => {
    const claude: ModelClient = new Anthropic({ apiKey: "unused" });
    const openai: OpenAIClient = new OpenAI({ apiKey: "unused" });
    expect([claude, openai]).toHaveLength(2);
  });
});

describe("jsonSchemaFor", () => {
  it("is strict-compatible: closed objects, every field required, no number bounds", () => {
    const json = jsonSchemaFor(Fee) as { required: string[]; additionalProperties: boolean; properties: Record<string, Record<string, unknown>> };
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(["name", "cents", "note", "tags"]);
    expect(json.properties.note).toEqual({ type: ["string", "null"] });
    expect(json.properties.cents).toEqual({ type: "integer" });
    expect(json).not.toHaveProperty("$schema");
  });
});

describe("claudeReader", () => {
  it("sends the schema, images and effort, and returns the validated value with its cost", async () => {
    const { client, seen } = fakeClaude(claudeMessage());
    const answer = await claudeReader(client, "claude-sonnet-5-5").ask(ask);

    expect(answer).toEqual({ value: GOOD, model: "claude-sonnet-5-5", usd: (1000 * 2 + 500 * 10) / 1e6 });
    const params = seen[0]!;
    expect(params.system).toBe("Read the fee.");
    expect(params.output_config).toEqual({ effort: "high", format: { type: "json_schema", schema: jsonSchemaFor(Fee) } });
    expect(params.messages[0]!.content).toEqual([
      { type: "text", text: "Page 3" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
    ]);
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
  });

  it("prices cache reads and writes", async () => {
    const usage = { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000 };
    const answer = await claudeReader(fakeClaude(claudeMessage({ usage })).client, "claude-sonnet-5-5").ask(ask);
    expect(answer.usd).toBeCloseTo((100 * 2 + 1000 * 2.5 + 10000 * 0.2) / 1e6);
  });

  it("refuses a model with no known price", () => {
    expect(() => claudeReader(fakeClaude(claudeMessage()).client, "claude-unknown")).toThrow(/No price is known/);
  });

  it.each([
    ["a refusal", { stop_reason: "refusal" }, /declined/],
    ["a cut-off answer", { stop_reason: "max_tokens" }, /ran out of room/],
    ["no text", { content: [] }, /wasn't valid JSON/],
  ])("throws on %s", async (_, over, message) => {
    const failed = claudeReader(fakeClaude(claudeMessage(over)).client, "claude-sonnet-5-5").ask(ask);
    await expect(failed).rejects.toThrow(message);
    expect(spentOn(await failed.catch((e: unknown) => e))).toBeGreaterThan(0);
  });

  it("throws on output that isn't JSON or doesn't match the schema", async () => {
    const reader = (text: string) => claudeReader(fakeClaude(claudeMessage({}, text)).client, "claude-sonnet-5-5");
    await expect(reader("not json").ask(ask)).rejects.toThrow(/wasn't valid JSON/);
    await expect(reader(JSON.stringify({ ...GOOD, cents: "12" })).ask(ask)).rejects.toThrow(/didn't match the expected shape \(cents:/);
  });
});

describe("openaiReader", () => {
  it("sends the schema, images and effort, and returns the validated value with its cost", async () => {
    vi.stubEnv("OPENAI_PRICE_PER_MTOK", "5,30");
    const { client, seen } = fakeOpenAI(openaiResponse());
    const answer = await openaiReader(client, "gpt-5.5").ask(ask);

    expect(answer).toEqual({ value: GOOD, model: "gpt-5.5", usd: (2000 * 5 + 1000 * 30) / 1e6 });
    const params = seen[0]!;
    expect(params.model).toBe("gpt-5.5");
    expect(params.instructions).toBe("Read the fee.");
    expect(params.reasoning).toEqual({ effort: "high" });
    expect(params.text).toEqual({ format: { type: "json_schema", name: "read_fee", strict: true, schema: jsonSchemaFor(Fee) } });
    expect(params.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Page 3" },
          { type: "input_image", detail: "high", image_url: `data:image/png;base64,${PNG.toString("base64")}` },
        ],
      },
    ]);
  });

  it("throws when the price is not configured", () => {
    vi.stubEnv("OPENAI_PRICE_PER_MTOK", "");
    expect(() => openaiReader(fakeOpenAI(openaiResponse()).client, "gpt-5.5")).toThrow(/OPENAI_PRICE_PER_MTOK/);
  });

  it.each([
    ["a refusal", { output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], output_text: "" }, /declined/],
    ["a cut-off answer", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, /ran out of room/],
    ["a content-filter stop", { status: "incomplete", incomplete_details: { reason: "content_filter" } }, /content filter/],
    ["a failed response", { status: "failed", error: { message: "boom" } }, /boom/],
    ["missing usage", { usage: undefined }, /spend can't be counted/],
    ["output that isn't JSON", { output_text: "oops" }, /wasn't valid JSON/],
    ["output that doesn't match the schema", { output_text: JSON.stringify({ name: "x" }) }, /didn't match the expected shape/],
  ])("throws on %s", async (_, over, message) => {
    vi.stubEnv("OPENAI_PRICE_PER_MTOK", "5,30");
    await expect(openaiReader(fakeOpenAI(openaiResponse(over)).client, "gpt-5.5").ask(ask)).rejects.toThrow(message);
  });
});

describe("openaiPrice", () => {
  it("reads input and output dollars per million tokens", () => {
    expect(openaiPrice("5,30")).toEqual({ input: 5, output: 30, cacheWrite: 0, cacheRead: 0 });
    expect(openaiPrice(" 1.25 , 10 ")).toMatchObject({ input: 1.25, output: 10 });
  });

  it.each([undefined, "", "5", "5,", "a,b", "5,30,1", "0,30", "-1,30"])("rejects %j", (spec) => {
    expect(() => openaiPrice(spec)).toThrow(/OPENAI_PRICE_PER_MTOK/);
  });
});
