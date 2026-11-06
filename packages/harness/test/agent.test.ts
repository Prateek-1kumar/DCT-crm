import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rulebook } from "@dct/shared";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/agent";
import { normalizeAccounted } from "../src/agent/normalize";
import { createSession } from "../src/agent/session";
import { withScans } from "../src/scan";
import type { ModelClient, ModelMessage, ModelParams } from "../src/agent/client";
import { pdfReader } from "../src/pdf";
import { parseTranscription, type Transcription } from "../src/scan/transcribe";
import type { LoadedDoc } from "../src/types";
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

  it("refuses to set an amount aside as corrected by a person: only a person's answer does that", () => {
    const refused = normalizeAccounted({ doc: "A.pdf", page: 1, cell: "p1.l1", reason: " Corrected by a Person " });
    expect(refused).toMatchObject({ ok: false, issues: [expect.stringMatching(/kept for amounts a person or a second read settled/)] });
    expect(normalizeAccounted({ doc: "A.pdf", page: 1, cell: "p1.l1", reason: "Corrected by a person." }).ok).toBe(false);
    expect(normalizeAccounted({ doc: "A.pdf", page: 1, cell: "p1.l1", reason: "printed twice" }).ok).toBe(true);
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
  const scanDoc = (lines: string[]): LoadedDoc => {
    const doc = textDoc(...lines);
    return { ...doc, pages: [{ ...doc.pages[0]!, kind: "scan" }] };
  };
  const transcribed = (lines: Transcription["lines"]) =>
    withScans({ ...textDoc("x"), pages: [{ ...textDoc("x").pages[0]!, kind: "image", words: [] }] }, [{ page: 1, version: "v", rotation: 0, transcription: { rotation: 0, lines, tables: [] } }]);
  const NOTE = "SCAN: read from the page image by a vision model. Every amount you take from it cites the id of the cell or line it is printed in; quote the printed words without ids, | or marks.";
  const read = async (doc: LoadedDoc) => {
    const { calls } = await run([doc], [reply([call("read_pages", { doc: "A.pdf", pages: [1] })]), reply([])], { maxTurns: 2 });
    return calls;
  };

  it("are labelled in the inventory and in read_pages, which returns their text under the note", async () => {
    const calls = await read(scanDoc(BUDGET));
    expect(String(calls[0]!.messages[0]!.content)).toContain(`p1: ${NOTE}, `);
    expect(String(resultsAfter(calls[1]!.messages)[0]!.content)).toBe(`=== A.pdf p1 ===\n(${NOTE})\n${BUDGET.join("\n")}`);
  });

  it("read_pages shows a scan page's doubts once, on the values they apply to", async () => {
    const calls = await read(transcribed([{ text: "Fee $1,250.00 and $900.00", top: 0.1, bottom: 0.12, unsure: true, marks: ["handwritten"], parts: [{ text: "Fee $1,250.00 and", unsure: true, marks: [] }, { text: "$900.00", unsure: false, marks: ["handwritten"] }] }]));
    expect(String(resultsAfter(calls[1]!.messages)[0]!.content)).toBe(`=== A.pdf p1 ===\n(${NOTE})\np1.l1 | Fee $1,250.00 and{?} $900.00{hw}`);
  });

  it("read_pages shows a doubtful bank number masked, as it does a certain one", async () => {
    const calls = await read(transcribed([{ text: "Account number", top: 0.1, bottom: 0.12, unsure: false, marks: [] }, { text: "123456789", top: 0.2, bottom: 0.22, unsure: true, marks: [] }, { text: "Fee $1,250.00", top: 0.3, bottom: 0.32, unsure: false, marks: [] }]));
    const shown = String(resultsAfter(calls[1]!.messages)[0]!.content);
    expect(shown).toContain("p1.l2 | #########{?}");
    expect(shown).not.toContain("123456789");
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

  it("the compile agent can't reach a locked field through a nested path", async () => {
    const options = [{ label: "Use $250.00", patch: { target: "grid", id: "g1", set: { "rows.0.cells.1": 25000, "cellsReadTwice.0": [0, 1], "acceptedAsPrinted.x": true } } }];
    const asked = { id: "q1", kind: "decision", question: "Which one?", source: { doc: "A.pdf", page: 1, quote: "Exhibit A Budget" }, options };
    const { result } = await run([textDoc(...BUDGET)], [reply([call("put_study", { study }), call("put_terms", { terms: [startup] }), call("put_grid", { grid }), call("put_questions", { questions: [asked] })]), reply([call("finish")])]);

    expect(result.rulebook.questions[0]!.options[0]!.patches).toEqual([{ target: "grid", id: "g1", set: { "rows.0.cells.1": 25000 } }]);
  });
});

describe("a citation in an option", () => {
  it("an option written by the compile agent can't clear a citation", async () => {
    const options = [
      { label: "Use $250.00", patches: [{ target: "grid", id: "g1", set: { "rows.0.cells.1": 25000, "cellIds.rows.0.cells.0": null, cellIds: {} } }, { target: "term", id: "t1", set: { notes: "x", "source.cell": null, "source.capCell": "p1.l1" } }] },
    ];
    const asked = { id: "q1", kind: "decision", question: "Which one?", source: { doc: "A.pdf", page: 1, quote: "Exhibit A Budget" }, options };
    const { result } = await run([textDoc(...BUDGET)], [reply([call("put_study", { study }), call("put_terms", { terms: [startup] }), call("put_grid", { grid }), call("put_questions", { questions: [asked] })]), reply([call("finish")])]);

    expect(result.rulebook.questions[0]!.options[0]!.patches).toEqual([
      { target: "grid", id: "g1", set: { "rows.0.cells.1": 25000 } },
      { target: "term", id: "t1", set: { notes: "x" } },
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

describe("scanned values cite cells", () => {
  const scanned = (...pages: string[]): LoadedDoc => {
    const blank = textDoc("x").pages[0]!;
    return withScans(
      { ...textDoc("x"), pages: pages.map((_, i) => ({ ...blank, page: i + 1, kind: "image" as const, words: [] })) },
      pages.map((text, i) => ({ page: i + 1, version: "v", rotation: 0, transcription: parseTranscription({ rotation: 0, text }) })),
    );
  };
  const fees = scanned(["T 0.3-0.6 | Fees", "H | Item | Fee | Fee with overhead", "R 0.31-0.32 | Exam | $1,520.00 | $1,976.00"].join("\n"));
  const exam = (amount: string, cell?: string) => ({ ...startup, name: "Exam", amount, source: { doc: "A.pdf", page: 1, quote: "Exam", ...(cell && { cell }) } });
  const putTerms = async (doc: LoadedDoc, ...terms: unknown[]) => {
    const { result, calls } = await run([doc], [reply([call("put_terms", { terms })]), reply([])], { maxTurns: 2 });
    return { saved: result.rulebook.terms, answer: resultsAfter(calls[1]!.messages)[0]! };
  };

  it("a scanned term whose value differs from its cited cell is refused at put_terms", async () => {
    const { saved, answer } = await putTerms(fees, exam("$1,250.00", "p1.t1.r1.c1"));
    expect(answer.is_error).toBe(true);
    expect(answer.content).toContain(`Term t1: the amount is $1,250.00, but cell p1.t1.r1.c1 prints "$1,520.00"`);
    expect(saved).toEqual([]);
  });

  it("a scanned term must cite a cell", async () => {
    const { saved, answer } = await putTerms(fees, exam("$1,520.00"), { ...exam("$1,520.00", "p1.t1.r2.c1"), id: "t2" });
    expect(answer.is_error).toBe(true);
    expect(answer.content).toContain("Term t1: the amount is on a scanned page, so it has to cite the cell or line it is printed in (source.cell)");
    expect(answer.content).toContain("Term t2: the amount cites p1.t1.r2.c1, but A.pdf has no cell or line with that id");
    expect(saved).toEqual([]);
  });

  it("a term may cite the fee column next to a fee-with-overhead column", async () => {
    const { saved, answer } = await putTerms(fees, exam("$1,520.00", "p1.t1.r1.c1"));
    expect(answer.is_error).toBe(false);
    expect(saved[0]!.source.cell).toBe("p1.t1.r1.c1");
    expect(saved[0]!.amountCents).toBe(152000);
    expect((await putTerms(fees, exam("$1,520.00", "p1.t1.r1.c2"))).answer.content).toContain(`but cell p1.t1.r1.c2 prints "$1,976.00"`);
  });

  it("the agent writes relations, but only code decides what they prove", async () => {
    const withOverhead = scanned(
      ["L 0.1-0.12 | Overhead of 30% is added to every fee", "T 0.3-0.6 | Fees", "H | Item | Fee | Fee with overhead", "R 0.31-0.32 | Exam | $1,520.00 | $1,976.00", "R 0.33-0.34 | Labs | $100.00 | $140.00"].join("\n"),
    );
    const holds = { kind: "sum", doc: "A.pdf", result: "p1.t1.r1.c2", operands: ["p1.t1.r1.c1"], rate: "p1.l1" };
    const fails = { ...holds, result: "p1.t1.r2.c2", operands: ["p1.t1.r2.c1"] };
    const labs = { ...exam("$100.00"), id: "t2", name: "Labs", source: { doc: "A.pdf", page: 1, quote: "Labs", cell: "p1.t1.r2.c1" } };
    const { result, calls } = await run(
      [withOverhead],
      [reply([call("put_terms", { terms: [exam("$1,520.00", "p1.t1.r1.c1"), labs] })]), reply([call("put_relations", { relations: [holds, fails, { ...holds, operands: "p1.t1.r1.c1", evidence: "math" }] })]), reply([])],
      { maxTurns: 3 },
    );
    const answer = resultsAfter(calls[2]!.messages)[0]!;
    expect(answer.is_error).toBe(true);
    expect(answer.content).toContain("Relation #2: p1.t1.r2.c2 = p1.t1.r2.c1 plus p1.l1 on top doesn't hold: the cells it is made of come to $130.00, but p1.t1.r2.c2 prints $140.00.");
    expect(answer.content).toContain("Relation #1: p1.t1.r1.c2 = p1.t1.r1.c1 plus p1.l1 on top proves all 3 of its cells.");
    expect(result.rulebook.relations).toEqual([holds]);
    expect(result.rulebook.terms.map((t) => t.evidence)).toEqual(["math", "none"]);
  });

  it("two sums on one result cell are both kept, and prove nothing on their own", async () => {
    const totals = scanned(
      ["T 0.3-0.6 | Budget", "H | Item | V1 | V2 | Total", "R 0.31-0.32 | Exam | $100.00 | $200.00 | $300.00", "R 0.33-0.34 | Labs | $50.00 | $70.00 | $120.00", "R 0.35-0.36 | Total | $150.00 | $270.00 | $420.00"].join("\n"),
    );
    const grand = { ...exam("$420.00", "p1.t1.r3.c3"), name: "Total", source: { doc: "A.pdf", page: 1, quote: "Total", cell: "p1.t1.r3.c3" } };
    const byRow = { kind: "sum", doc: "A.pdf", result: "p1.t1.r3.c3", operands: ["p1.t1.r3.c1", "p1.t1.r3.c2"] };
    const byColumn = { ...byRow, operands: ["p1.t1.r1.c3", "p1.t1.r2.c3"] };
    const { result, calls } = await run(
      [totals],
      [reply([call("put_study", { study }), call("put_terms", { terms: [grand] })]), reply([call("put_relations", { relations: [byRow, byColumn] })]), reply([call("finish")]), reply([])],
      { maxTurns: 4 },
    );
    expect(String(resultsAfter(calls[2]!.messages)[0]!.content)).toContain("Saved 2 relations (2 in all).");
    expect(String(resultsAfter(calls[2]!.messages)[0]!.content)).toContain("holds, but a sum of several cells proves none of them on its own");
    expect(result.rulebook.relations).toEqual([byRow, byColumn]);
    expect(String(resultsAfter(calls[3]!.messages)[0]!.content)).not.toContain("Proven by arithmetic");
    expect(result.rulebook.terms[0]!.evidence).toBe("none");
  });

  it("an amount only a page's second read found is left to a person, and finish tells the agent not to account it away", async () => {
    const doc = scanned(["T 0.3-0.6 | Fees", "H | Item | Fee", "R 0.31-0.32 | Exam | $1,520.00"].join("\n"));
    doc.pages[0]!.second = parseTranscription({ rotation: 0, text: ["T 0.3-0.6 | Fees", "H | Item | Fee", "R 0.31-0.32 | Exam | $1,520.00", "R 0.33-0.34 | Labs | $80.00"].join("\n") });
    const session = createSession([doc], 3);
    await session.run("put_study", { study });
    await session.run("put_terms", { terms: [{ ...exam("$1,520.00", "p1.t1.r1.c1"), source: { doc: "A.pdf", page: 1, quote: "Exam $1,520.00", cell: "p1.t1.r1.c1" } }] });
    const finish = String((await session.run("finish", {})).content);
    expect(finish).toContain("ALL CHECKS PASS");
    expect(finish).toContain("never list these with put_accounted:\n$80.00 on p.1 of A.pdf was found only by a second reading of the page");
  });

  it("a scanned grid with row totals finishes without the agent being asked to prove its cells", async () => {
    const doc = scanned(["T 0.1-0.5 | Budget", "H | Procedure | V1 | V2 | Total", "R 0.11-0.12 | ECG | $100.00 | $40.00 | $140.00", "R 0.13-0.14 | Labs | $50.00 | $50.00 | $100.00"].join("\n"));
    const session = createSession([doc], 3);
    await session.run("put_study", { study });
    const at = (value: string, cell: string) => ({ value, cell });
    const grid = {
      id: "g1", name: "Budget", doc: "A.pdf", pages: [1], visits: ["V1", "V2"],
      rows: [
        { name: "ECG", cells: [at("$100.00", "p1.t1.r1.c1"), at("$40.00", "p1.t1.r1.c2")], printedRowTotal: at("$140.00", "p1.t1.r1.c3") },
        { name: "Labs", cells: [at("$50.00", "p1.t1.r2.c1"), at("$50.00", "p1.t1.r2.c2")], printedRowTotal: at("$100.00", "p1.t1.r2.c3") },
      ],
    };
    expect((await session.run("put_grid", { grid })).isError).toBe(false);
    const finish = String((await session.run("finish", {})).content);
    expect(finish).toContain("ALL CHECKS PASS");
    expect(finish).not.toContain("no printed total proving");
  });

  it("text-page terms need no citation", async () => {
    const { saved, answer } = await putTerms(textDoc(...BUDGET), startup);
    expect(answer.is_error).toBe(false);
    expect(saved[0]!.source).toEqual(startup.source);
  });

  it("a grid split over two pages cites each value on its own page", async () => {
    const split = scanned(
      ["T 0.1-0.5 | Budget", "H | Procedure | V1 | V2", "R 0.11-0.12 | Exam | $100.00 | $250.00"].join("\n"),
      ["T 0.1-0.5 | Budget (continued)", "H | Procedure | V3 | Total", "R 0.11-0.12 | Exam | $300.00 | $650.00"].join("\n"),
    );
    const at = (value: string, cell: string) => ({ value, cell });
    const twoPages = (v3: string) => ({
      id: "g1", name: "Main", doc: "A.pdf", pages: [1, 2], visits: ["V1", "V2", "V3"],
      rows: [{ name: "Exam", cells: [at("$100.00", "p1.t1.r1.c1"), at("$250.00", "p1.t1.r1.c2"), at("$300.00", v3)], printedRowTotal: at("$650.00", "p2.t1.r1.c2") }],
    });
    const { result, calls } = await run([split], [reply([call("put_grid", { grid: twoPages("p1.t1.r1.c2") })]), reply([call("put_grid", { grid: twoPages("p2.t1.r1.c1") })]), reply([])], { maxTurns: 3 });

    const refused = resultsAfter(calls[1]!.messages)[0]!;
    expect(refused.is_error).toBe(true);
    expect(refused.content).toContain(`row 'Exam' at visit 'V3' is $300.00, but cell p1.t1.r1.c2 prints "$250.00"`);
    expect(resultsAfter(calls[2]!.messages)[0]!.content).toContain("3 cells add up with the printed totals, but on a SCAN page a total alone doesn't prove a cell");
    expect(result.rulebook.grids[0]!.cellIds).toEqual({ "rows.0.cells.0": "p1.t1.r1.c1", "rows.0.cells.1": "p1.t1.r1.c2", "rows.0.cells.2": "p2.t1.r1.c1", "rows.0.printedRowTotalCents": "p2.t1.r1.c2" });
    expect(result.rulebook.grids[0]!.rows[0]!.cells).toEqual([10000, 25000, 30000]);
  });
});
