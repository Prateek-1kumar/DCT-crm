import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rulebook } from "@dct/shared";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/agent";
import { withScans } from "../src/scan";
import type { ModelClient, ModelMessage, ModelParams } from "../src/agent/client";
import { pdfReader } from "../src/pdf";
import type { Doubt, LoadedDoc } from "../src/types";
import { wordsOf } from "./words";

const BUDGET = [
  "Exhibit A Budget",
  "Visit            V1         V2        Total",
  "Exam          $100.00    $250.00    $350.00",
  "Total         $100.00    $250.00",
  "Startup fee $1,234.56 payable on signature.",
];
const INSURANCE = "Insurance limit $5,000.00 per claim.";

const textDoc = (...lines: string[]): LoadedDoc => {
  const layout = lines.join("\n");
  return { name: "A.pdf", path: "/x/A.pdf", sha256: "0", pages: [{ page: 1, kind: "text", layout, raw: layout, words: wordsOf(layout), maskBoxes: [], firstLine: lines[0]!, rotation: 0 }] };
};

type Block = Record<string, unknown>;
let nextId = 0;
const call = (name: string, input: unknown = {}): Block => ({ type: "tool_use", id: `tu_${++nextId}`, name, input });
const reply = (content: Block[], output = 500): ModelMessage =>
  ({
    id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5-5", content,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: 1000, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }) as unknown as ModelMessage;

function fake(script: ModelMessage[]) {
  const calls: { params: ModelParams; messages: ModelParams["messages"] }[] = [];
  const client: ModelClient = {
    beta: {
      messages: {
        stream(params) {
          calls.push({ params, messages: structuredClone(params.messages) });
          const next = script.shift();
          if (!next) throw new Error("the script has no more replies");
          return { finalMessage: async () => next };
        },
      },
    },
  };
  return { client, calls };
}

const resultsAfter = (messages: ModelParams["messages"]) => {
  const last = messages.at(-1)!;
  return last.content as { type: string; tool_use_id: string; content: unknown; is_error: boolean }[];
};

const study = { protocol: "P-1", sponsor: "Acme", siteEntity: "Site LLC", documents: [{ doc: "A.pdf", role: "cta" }] };
const startup = { id: "t1", category: "site_fee", name: "Startup fee", amount: "$1,234.56", unit: "one time", billing: "invoice", source: { doc: "A.pdf", page: 1, quote: "Startup fee $1,234.56 payable on signature" } };
const grid = {
  id: "g1", name: "Main", doc: "A.pdf", pages: [1], visits: ["V1", "V2"],
  rows: [{ name: "Exam", cells: ["$100.00", 250], printedRowTotal: "$350.00" }],
  total: ["$100.00", "$250.00"], grandTotal: "$350.00",
};

const run = (docs: LoadedDoc[], script: ModelMessage[], opts: Partial<CompileOptions> = {}) => {
  const f = fake(script);
  return compile(docs, { client: f.client, ...opts }).then((result) => ({ result, calls: f.calls }));
};

describe("compile", () => {
  it("(a) reads a contract to a valid rulebook and stops when finish passes", async () => {
    const { result, calls } = await run(
      [textDoc(...BUDGET)],
      [
        reply([call("put_study", { study })]),
        reply([call("put_terms", { terms: [startup, { ...startup, id: "t2", name: "Other", amount: null, source: { doc: "A.pdf", page: 1, quote: "not on this page" } }] })]),
        reply([call("put_terms", { terms: [{ ...startup, id: "t2", name: "Other", amount: null, source: { doc: "A.pdf", page: 1, quote: "Exhibit A Budget" } }] }), call("put_grid", { grid })]),
        reply([call("finish")]),
      ],
    );
    expect(result.stopReason).toBe("done");
    expect(result.finishes).toBe(1);
    expect(result.turns).toBe(4);
    expect(Rulebook.safeParse(result.rulebook).success).toBe(true);
    const t1 = result.rulebook.terms.find((t) => t.id === "t1")!;
    expect(t1.amountCents).toBe(123456);
    expect(t1.evidence).toBe("quote");
    expect(result.rulebook.grids[0]!.rows[0]!.cells).toEqual([10000, 25000]);
    expect(result.rulebook.grids[0]!.grandTotalCents).toBe(35000);
    expect(resultsAfter(calls[2]!.messages)[0]!.content).toContain("Quotes not found: t2");
    expect(resultsAfter(calls[3]!.messages)[1]!.content).toContain("PROVEN");
    expect(result.usd).toBeCloseTo(4 * (1000 * 2 + 500 * 10) / 1e6, 10);
    expect(result.trace[1]!.toolCalls[0]).toMatchObject({ name: "put_terms" });
  });

  it("sends the cost-saving and refusal-fallback settings on every call", async () => {
    const { calls } = await run([textDoc(...BUDGET)], [reply([call("put_study", { study })]), reply([call("finish")]), reply([call("finish")]), reply([call("finish")])], { maxFinishes: 2 });
    expect(calls[0]!.params).toMatchObject({
      model: "claude-sonnet-5-5", max_tokens: 64000, output_config: { effort: "high" }, cache_control: { type: "ephemeral" },
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    });
    expect(calls[0]!.params).not.toHaveProperty("thinking");
  });

  it("(b) sends problems back from finish, and passes once the agent fixes them", async () => {
    const { result, calls } = await run(
      [textDoc(...BUDGET, INSURANCE)],
      [
        reply([call("put_study", { study }), call("put_terms", { terms: [startup] }), call("put_grid", { grid })]),
        reply([call("finish")]),
        reply([call("put_accounted", { items: [{ doc: "A.pdf", page: 1, amount: "$5,000.00", reason: "insurance limit" }] })]),
        reply([call("finish")]),
      ],
    );
    expect(String(resultsAfter(calls[2]!.messages)[0]!.content)).toMatch(/Finish 1 of 3: 1 thing to fix[\s\S]*UNACCOUNTED: \$5,000\.00/);
    expect(result.stopReason).toBe("done");
    expect(result.finishes).toBe(2);
    expect(result.rulebook.accounted).toEqual([{ doc: "A.pdf", page: 1, amountCents: 500000, reason: "insurance limit" }]);
  });

  it("(c) keeps the problems when the allowed finishes run out", async () => {
    const { result, calls } = await run(
      [textDoc(...BUDGET, INSURANCE)],
      [reply([call("put_study", { study }), call("put_terms", { terms: [startup] }), call("put_grid", { grid })]), reply([call("finish")]), reply([call("finish")])],
      { maxFinishes: 2 },
    );
    expect(result.stopReason).toBe("finishes_exhausted");
    expect(result.finishes).toBe(2);
    expect(result.report.unaccounted).toHaveLength(1);
    expect(result.trace[2]!.toolCalls[0]!.resultSummary).toContain("last finish");
    expect(calls).toHaveLength(3);
  });

  it("(d) stops before the next call once spending reaches the limit", async () => {
    const { result, calls } = await run([textDoc(...BUDGET)], [reply([call("put_study", { study })], 2000), reply([call("finish")])], { maxUsd: 0.01 });
    expect(result.stopReason).toBe("budget");
    expect(calls).toHaveLength(1);
    expect(result.usd).toBeGreaterThanOrEqual(0.01);
  });

  it("(e) rejects invalid input naming the field, then accepts the corrected call", async () => {
    const { result, calls } = await run(
      [textDoc(...BUDGET)],
      [reply([call("put_terms", { terms: [{ ...startup, category: "bogus" }] })]), reply([call("put_terms", { terms: [startup] })]), reply([call("search", { pattern: "(" })]), reply([])],
      { maxTurns: 4 },
    );
    const bad = resultsAfter(calls[1]!.messages)[0]!;
    expect(bad.is_error).toBe(true);
    expect(String(bad.content)).toMatch(/Term t1: category: .*payment_terms/);
    expect(resultsAfter(calls[2]!.messages)[0]!.is_error).toBe(false);
    expect(resultsAfter(calls[3]!.messages)[0]!).toMatchObject({ is_error: true });
    expect(result.rulebook.terms.map((t) => t.id)).toEqual(["t1"]);
  });

  it("(f) answers all tool calls of one turn in one user message and keeps the assistant turn unchanged", async () => {
    const first = reply([{ type: "thinking", thinking: "plan", signature: "sig" }, call("put_study", { study }), call("put_terms", { terms: [startup] })]);
    const content = structuredClone(first.content);
    const { calls } = await run([textDoc(...BUDGET)], [first, reply([])], { maxTurns: 2 });
    const sent = calls[1]!.messages;
    expect(sent).toHaveLength(3);
    expect(sent[1]).toEqual({ role: "assistant", content });
    const results = resultsAfter(sent);
    expect(results.map((r) => r.tool_use_id)).toEqual(content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id));
    expect(sent[2]!.role).toBe("user");
  });

  it("(g) adds the required-decision questions once, even if the agent raised the same one", async () => {
    const unknown = { ...startup, amount: null, billing: "unknown", source: { doc: "A.pdf", page: 1, quote: "Exhibit A Budget" } };
    const asked = { id: "rule:billing", kind: "decision", question: "How is it paid?", source: { doc: "A.pdf", page: 1, quote: "Exhibit A Budget" }, options: [{ label: "Invoice" }] };
    const { result } = await run(
      [textDoc("Exhibit A Budget", "Startup fee payable on signature.")],
      [reply([call("put_study", { study }), call("put_terms", { terms: [unknown] }), call("put_questions", { questions: [asked] })]), reply([call("finish")])],
    );
    expect(result.stopReason).toBe("done");
    const ids = result.rulebook.questions.map((q) => q.id);
    expect(ids).toEqual(["rule:billing"]);
    const noAsk = await run([textDoc("Exhibit A Budget", "Startup fee payable on signature.")], [reply([call("put_study", { study }), call("put_terms", { terms: [unknown] })]), reply([call("finish")])]);
    expect(noAsk.result.rulebook.questions).toMatchObject([{ id: "rule:billing", origin: "rule", state: "open" }]);
  });

  it("(i) returns what was written so far when the model call fails", async () => {
    const f = fake([reply([call("put_study", { study })])]);
    const result = await compile([textDoc(...BUDGET)], { client: f.client });
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("no more replies");
    expect(result.rulebook.study.protocol).toBe("P-1");
  });
});

describe("scan pages", () => {
  const scanDoc = (lines: string[], doubts: Record<string, Doubt> = {}): LoadedDoc => {
    const doc = textDoc(...lines);
    const page = doc.pages[0]!;
    return { ...doc, pages: [{ ...page, kind: "scan", words: page.words.map((w) => (doubts[w.text] ? { ...w, doubt: doubts[w.text] } : w)) }] };
  };
  const NOTE = "SCAN: text read from the page image by a vision model; amounts the contract's arithmetic doesn't prove are re-read at zoom after you finish. Quote the words as transcribed.";
  const read = async (doc: LoadedDoc) => {
    const { calls } = await run([doc], [reply([call("read_pages", { doc: "A.pdf", pages: [1] })]), reply([])], { maxTurns: 2 });
    return calls;
  };

  it("are labelled in the inventory and in read_pages, which returns their text under the note", async () => {
    const calls = await read(scanDoc(BUDGET));
    expect(String(calls[0]!.messages[0]!.content)).toContain(`p1: ${NOTE}, `);
    expect(String(resultsAfter(calls[1]!.messages)[0]!.content)).toBe(`=== A.pdf p1 ===\n(${NOTE})\n${BUDGET.join("\n")}`);
  });

  it("read_pages lists doubtful words on a scan page", async () => {
    const calls = await read(scanDoc(["Fee $1,250.00 and $900.00 and $50.00"], { "$1,250.00": "unsure", "$900.00": "handwritten" }));
    expect(String(resultsAfter(calls[1]!.messages)[0]!.content)).toBe(
      `=== A.pdf p1 ===\n(${NOTE})\nFee $1,250.00 and $900.00 and $50.00\nDoubtful on this page: "$1,250.00" (unsure); "$900.00" (handwritten)`,
    );
  });

  it("read_pages shows a doubtful bank number masked, as it does a certain one", async () => {
    const page = { page: 1, version: "v", rotation: 0, words: wordsOf("Account number 123456789\nFee $1,250.00").map((w) => (w.text === "123456789" ? { ...w, doubt: "unsure" as const } : w)) };
    const [masked] = [withScans({ ...textDoc("x"), pages: [{ ...textDoc("x").pages[0]!, kind: "image", words: [] }] }, [page])];
    const calls = await read(masked!);
    const shown = String(resultsAfter(calls[1]!.messages)[0]!.content);
    expect(shown).toContain('Doubtful on this page: "#########" (unsure)');
    expect(shown).not.toContain("123456789");
  });

  it("read_pages adds no doubt line when there are none", async () => {
    const calls = await read(scanDoc(["Fee $1,250.00"]));
    expect(String(resultsAfter(calls[1]!.messages)[0]!.content)).not.toContain("Doubtful");
  });

  it("leave their amounts to the harness's own proof, so finish can pass without them", async () => {
    const { result } = await run(
      [scanDoc(["Startup fee $1,234.56 payable on signature."])],
      [reply([call("put_study", { study }), call("put_terms", { terms: [startup] })]), reply([call("finish")])],
    );
    expect(result.stopReason).toBe("done");
    expect(result.report.quotes.t1).toMatch(/^scanned page/);
  });
});

describe("a grid the agent writes", () => {
  it("the compile agent can't mark a grid as accepted as printed", async () => {
    const failing = { ...grid, grandTotal: "$999.00", acceptedAsPrinted: true };
    const { result } = await run([textDoc(...BUDGET)], [reply([call("put_study", { study }), call("put_terms", { terms: [startup] }), call("put_grid", { grid: failing })]), reply([call("finish")])], { maxFinishes: 1 });

    expect(result.rulebook.grids[0]!.acceptedAsPrinted).toBe(false);
    expect(result.report.grids["g1"]!.problems).not.toEqual([]);
  });
});

describe("a question the agent writes", () => {
  it("the compile agent can't write a question option that marks a grid accepted as printed or read twice", async () => {
    const options = [
      { label: "Use $250.00", patch: { target: "grid", id: "g1", set: { "rows.0.cells.1": 25000, acceptedAsPrinted: true, cellsReadTwice: [[0, 1]] } } },
      { label: "Use $100.00", patches: [{ target: "term", id: "t1", set: { amountCents: 100, evidence: "person", id: "other" } }] },
    ];
    const asked = { id: "q1", kind: "decision", question: "Which one?", source: { doc: "A.pdf", page: 1, quote: "Exhibit A Budget" }, options };
    const { result } = await run([textDoc(...BUDGET)], [reply([call("put_study", { study }), call("put_terms", { terms: [startup] }), call("put_grid", { grid }), call("put_questions", { questions: [asked] })]), reply([call("finish")])]);

    expect(result.rulebook.questions[0]!.options.map((o) => o.patches)).toEqual([
      [{ target: "grid", id: "g1", set: { "rows.0.cells.1": 25000 } }],
      [{ target: "term", id: "t1", set: { amountCents: 100 } }],
    ]);
  });
});

describe("view_page", () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("(h) returns the page as an image block in the tool result", async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-agent-"));
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([612, 792]).drawText("Exhibit A Budget", { x: 50, y: 740, size: 14, font });
    const path = join(dir, "B.pdf");
    await writeFile(path, await pdf.save());
    const doc = await pdfReader.load(path);

    const { calls, result } = await run(
      [doc],
      [reply([call("view_page", { doc: "B.pdf", page: 1, region: [0, 0, 0.5, 0.5], dpi: 100 }), call("view_page", { doc: "B.pdf", page: 9 })]), reply([])],
      { maxTurns: 2 },
    );
    const [ok, bad] = resultsAfter(calls[1]!.messages);
    const image = (ok!.content as { type: string; source: { media_type: string; data: string } }[])[0]!;
    expect(image.type).toBe("image");
    expect(image.source.media_type).toBe("image/png");
    expect(Buffer.from(image.source.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(bad).toMatchObject({ is_error: true });
    expect(result.trace[0]!.toolCalls[0]!.resultSummary).toMatch(/^image of p1/);
  });
});
