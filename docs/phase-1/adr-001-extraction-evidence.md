# ADR-001: Contract extraction requires evidence for every value

**Status:** Proposed, 2026-10-28. **Decides:** Prateek.
**Replaces:** in `docs/phase-1/extraction.md`, the 2026-10-26 cost decision (the $1 cap, the Haiku cross-read, no re-reads once the cap is reached), and the Phase 1 decision that "OpenAI independently re-reads all amounts and rules".

**Inputs:** the code at `79da624`, the saved runs in `data/extractions/`, the signed COPD original, the user's answers of 2026-10-28, and two research passes (sources at the end). Every number in §1 was measured in this review; none was taken from the brief.

---

## 1. What we found

| Belief | What the code and data show |
|---|---|
| "97.5–100% accurate" | **This number measures recall against partial answer keys, with loose name matching (`sharesWord`), and no precision measure.** Of about 1,880 extracted grid cells, only COPD's 593 are scored cell by cell; the McAllen, HCWC and Shah grids are scored only through visit totals. COPD extracted 39 fees and invoiceables; the key lists 18. |
| The test PDFs represent production | **All 4 test CTAs are image-only:** 0 text characters on all 73 pages. The Downloads copies are byte-identical. **Future contracts will be e-signed text PDFs** (user, 2026-10-28). The eval tests the exception, not the normal case. |
| `TEXT_LAYER_MISMATCH` catches misreads | It only checks that the amount appears somewhere on the cited page. On the signed COPD PDF, **3,364 of the 22,339 possible single-digit misreads of grid cells (15.1%) would pass**, because the misread amount is printed elsewhere on the same page. |
| Nothing money-related is dropped | **Nothing checks in the direction document → rulebook.** The cheapest model (Haiku) decides which pages the terms reader sees (`extract.ts:175`); on COPD, 12 of 20 pages are never read for terms. The prompt restricts deadlines to "only these kinds" (`prompts.ts:102`), which tells the model to drop every other kind. A holdback the model misses comes out as `null`, which means "the contract has no holdback". |
| A completeness check would be too noisy | On the signed COPD PDF, **all 128 dollar amounts in the text layer are used by some rulebook value.** 88 of the 89 `%` tokens are drug concentrations in a medication exhibit. Checking every token is noisy; checking only numbers inside money sentences is not (§3). |
| The second read is a check | HCWC: 338 fields differ, giving 89 flags. McAllen: gpt-5.5 was wrong in every disagreement we checked. The current default is Haiku at low effort, on terms only. Research: when two models are both wrong they give the same wrong answer about 60% of the time (33% by chance), and models from the same vendor are more alike [1][2]. **Agreement between two models is weak evidence.** |
| Low confidence means a likely error | The model rates its own confidence. HCWC got 47 flags from it. Research: verbalized confidence scores about 0.69 AUROC on invoice fields, barely better than chance [3]. The Claude API has no logprobs. |
| Sign-off is a control | **Any anomaly, blockers included, can be cleared with "accepted with note" and any text** (`apps/api/src/routes/versions.ts`). Severity only changes how the flag looks. Research: visually checking pre-filled values is no better than single entry, and gives about 30× the errors of double entry [5]. Reviewers miss 18–23% of planted digit and wrong-cell errors [6]. |
| The $1 guard protects us | It refuses the extraction, or skips re-reads, to stay under $1. At 3 contracts a month, $1 vs $5 per contract is $12 a month. One silent error costs thousands. |
| There are uncommitted changes | No. The working tree is clean. The text-layer check and the xlsx grid key are in `79da624`. |

## 2. Decision

The pipeline keeps its shape: vision LLM → typed rulebook → deterministic checks → human sign-off. What changes is what "checked" means.

> **Today a value counts as right unless something flags it. From now on a value is unconfirmed until independent evidence or a person confirms it, and every page of the document is swept for money terms the rulebook didn't capture.** Flags are what remains after that, not the output of a model doubting itself.

**Keep**
- The vision read of page images.
- The typed rulebook: integer cents and provenance.
- The arithmetic checks.
- The contract-defect checks: grid conflict, overhead label, header, referenced documents, retroactive amendment.
- Immutable signed versions and the audit log.

**Change**
- The PDF text layer checks every digit, by position, not by page.
- Each draft carries an evidence ledger: one status per value.
- Every page is swept for money terms, whatever its classification.
- The schema gets `other` on every enum and an `unclassified` list.
- The API enforces how each severity can be cleared.
- The budget guard becomes a runaway cap.

**Remove**
- `LOW_CONFIDENCE` flags.
- The second-model cross-read (the Haiku path and the OpenAI client).
- The classifier deciding which pages get read.
- Skipping re-reads to save cost.
- The contract-specific prompt hints and check heuristics listed in §8.

**Alternatives considered**

| Alternative | Why not |
|---|---|
| A second model as the check | Its errors are correlated with the first model's [1][2], and it was measured as noise here: on HCWC, 338 differing fields became 89 flags, with nothing to say which side was right. |
| Parsing tables from the text layer with no AI | Grid layouts vary and still need meaning: which rows are subtotals, which are invoiceable. We use the text layer to verify, not to read. |
| Humans key everything twice, no AI | This is the accuracy gold standard (0.14% vs 0.29% error for single entry [4]), but it takes half a day per grid. We use double entry selectively: on flags, interpretations and a random sample. |
| An off-the-shelf review layer | AWS A2I is closed to new customers, and Google's Document AI human review is shut down [10]. The review layer we need is small; we build it. |

## 3. Invariants

The API blocks sign-off unless all six hold.

| # | Invariant |
|---|---|
| **I1 Grounding** | Every money value (amount, %, days, count, ratio, money date) is bound to visible text on a page, or a person typed it. Bound means the text sits at the value's position (a grid cell) or inside a quote that matches the page word for word. |
| **I2 Evidence** | Every value has one of two statuses. `confirmed`: two independent channels agree; on text PDFs, the vision read equals the text at the bound position. `attested`: a person typed or chose it without seeing the AI's answer. Nothing else can be signed. |
| **I3 Coverage** | Every money-relevant span in the documents is accounted for: bound to a value, listed as unclassified, or dismissed by a person with a reason. An unaccounted span is a blocker. |
| **I4 Absence** | An empty field ("no holdback", "no cap") can be signed only if the sweep found no unaccounted sentence containing that field's keywords. |
| **I5 Pages** | Every page is swept. Every page has a usable text source or is flagged unreadable. |
| **I6 Clearance** | Blockers clear only through a typed value or a structured choice, never through free-text "accept". |

**Money-relevant span.** A span counts if it is any of these:
- a currency amount;
- any number in a grid row band;
- a %, day/week/month count, ratio or "up to / maximum of N" in a sentence that contains a money keyword (pay, invoice, fee, cost, reimburs, overhead, indirect, F&A, holdback, withh, retain, refund, offset, interest, late, cap, not to exceed, escalat, increase, stipend, screen fail, terminat, budget, compensat);
- any sentence containing an absence keyword (holdback/withhold/retain, interest/late, escalat/increase/inflation, not to exceed/maximum/cap, screen fail, terminat), even without a number.

Spans that hold bank or payment instructions are excluded and masked (§9).

**Can the invariants be met?**
- **Text PDFs: yes, by code, without AI.** The remaining gap is a money clause that has no number and no keyword. The held-out run measures it as "silent misses".
- **Scans: not by code.** Without OCR there is nothing to sweep. Scans are rare (user, 2026-10-28), so **scan mode** applies:
  1. Ask for the e-signed original first.
  2. Otherwise the reviewer attests every page ("no money terms here except those listed").
  3. The reviewer types every value that arithmetic doesn't confirm.

  Add OCR only if scans exceed about 1 contract in 10.

**What breaks them, and the response**

| Failure | Response |
|---|---|
| The text layer doesn't match the page: a remapped font, white or tiny text, or a scanner's OCR layer passing as real text | Detect it, raise `HIDDEN_TEXT`, and treat the page as a scan. |
| A budget exhibit pasted into the DocuSign PDF as an image | Image regions on text pages get scan mode. |
| Amounts written in words ("ten percent") | Add number-word patterns to the sweep. |
| Struck-through text | It stays in the text layer, so it surfaces as unaccounted, which is visible. |
| Handwriting on a scan | Covered by page attestation. |
| Terms in documents that weren't uploaded | `MISSING_REFERENCED_DOC` (exists). |

## 4. Sources of evidence, ranked by independence

| # | Source | Proves | Does not prove | Role |
|---|---|---|---|---|
| 1 | **Text layer of a born-digital PDF** (visible text only) | The exact characters as signed, and where they sit on the page. No model involved. | Meaning. It can be manipulated (fonts, hidden text). | The primary check on every digit and position, and the source of the coverage sweep. |
| 2 | **A person typing without seeing the AI's answer** | Anything. | — (it is slow) | Flags, interpretations, and the random sample. |
| 3 | **The document's own arithmetic** | Totals are consistent. | Which row a cell belongs to (two cells swapped within one visit keep the total), or terms that aren't summed. | The confirmation for scans; on text PDFs, a detector of mistakes in the contract itself. |
| 4 | **Sponsor payments (Phase 3) and any typed price list** | That an independent party uses the same rate. | — (arrives after go-live) | Ongoing confirmation (§7). |
| 5 | **Sponsor budget .xlsx** | Independent, but it is not the signed document. | Anything, on its own: the COPD file named "Final" contained draft fee sheets. | A corroborator, sheet by sheet, and only when the sheet's totals reconcile with the signed PDF. Never a source. **Filenames lie, so the rule "drafts won't be uploaded" can't be enforced by people; reconciliation enforces it.** |
| 6 | **Second LLM read** | Little: its errors are correlated with the first read's [1][2]. | — | Not evidence. Used only as an automatic re-read when the two channels conflict, never as confirmation. |
| 7 | **The model's self-reported confidence** | Nothing usable [3]. | — | Kept in the ledger, never flagged. |

**When the PDF has text, which source leads?**
- The **text layer** leads on characters.
- The **vision read** leads on structure (which number is which field) and checks the text layer: a page whose rendering differs from its text raises a flag.
- **Don't give the reader the text layer.** Claude's PDF input adds it automatically [7], so keep sending page images. Two channels that can't see each other mean something when they agree.
- Trade-off: the model will misread digits it could have copied, which means more `VALUE_CONFLICT` flags. If the held-out run goes over the flag budget, give the model the text and rely on position checks alone.

**Plan for scans:** ask for the original, use scan mode (§3), and revisit OCR if scans exceed about 1 in 10.

## 5. Components and data flow

```
PDF(s)
 → Intake        sha256, page count, per-page text source (text / scanner-OCR layer / image-only), hidden-text scan
 → TextLayer     mupdf, no AI: visible spans with boxes · money-span inventory · bank spans masked out of every image sent
 → Classifier    Haiku: page kind + rotation; decides grid tiling only, never which pages are read
 → Reader        Claude, page images only: terms (ALL pages) + grids (400 DPI tiles) → draft rulebook with quotes
 → Binder        no AI: value → span(s); grid row → its row band, cells in column order; quote → word-for-word match
 → Ledger        per JSON pointer: confirmed | conflict | ungrounded | attested (+ sources)
 → Coverage      inventory − bound − unclassified − dismissed = unaccounted
 → Checks        arithmetic + contract defects (existing, heuristics removed)
 → Re-read       strongest model, only on grids/pages with conflicts; bind again
 → Review        flags (typed blind) · interpretations (picked blind) · unclassified list · 10-value blind sample · page attestation (scans)
 → Sign-off gate I1–I6 → signed version {rulebook, ledger, inventory, model ids, prompt hash, source hashes}
```

- The **rulebook stays the billing engine's only input.** The ledger and the inventory are stored with the version, for the gate and the audit trail.
- **Binder details:**
  - It works in the rotated frame of sideways grids.
  - It matches a row by the vertical band of its label.
  - It re-points a wrong page citation without a flag only when the label and the amount sit on one line of exactly one page. The COPD admin fee is that case. The move is recorded in the ledger.

## 6. Anomaly catalogue

Two severities, both enforced by the API.
- **Blocker:** cleared only by a typed value or a structured choice.
- **Review:** cleared by a typed value, a choice, or a reason from a fixed list plus a note.

| Code | Triggered by | Severity | How the reviewer clears it |
|---|---|---|---|
| `VALUE_CONFLICT` (replaces TEXT_LAYER_MISMATCH, AI_DISAGREEMENT) | The vision read differs from the text at the bound position. | Blocker | Types the value seen in the page crop, without seeing either candidate. If it matches the text, the conflict is resolved. If it matches only the vision read, the page is escalated as untrusted text. |
| `UNGROUNDED_VALUE` | No visible span on the cited page carries the value: row not found, quote doesn't match the page, or wrong page. | Blocker | Clicks the span on the page, or types the value and page. |
| `UNACCOUNTED_TERM` (new) | A span in the inventory is not bound, not unclassified and not dismissed. | Blocker | Maps it to a field, adds it as unclassified, or dismisses it with a reason (not a payment term / duplicate of X / superseded). A whole section, such as a medication list, can be dismissed at once, with its span count shown. |
| `HIDDEN_TEXT` (new) | Text in the layer is invisible (white, under 4 pt, off-page, invisible render mode), or the page's text and its rendering disagree on several spans. | Blocker | Confirms the hidden content is irrelevant; the page is handled as a scan. |
| `ARITHMETIC_MISMATCH` (merges VISIT_TOTAL and PER_PATIENT_TOTAL) | The text confirms the printed numbers and they don't add up: **the contract itself is wrong.** Not raised when a `VALUE_CONFLICT` on one of the numbers explains it. | Review | Chooses which number governs and writes a note for the sponsor query. |
| `GRID_CONFLICT` | Two grids for the same arm disagree. | Blocker | Chooses the governing grid (exists). |
| `HEADER_MISMATCH` | The grid header names another PI or site. | Blocker | Confirms the document belongs to this study, or removes it. |
| `RETROACTIVE_NO_DATE` | A retroactive amendment gives no start date. | Blocker | Types the date, or chooses "prospective only". |
| `REQUIRED_MISSING` / `UNREADABLE_PAGE` | A required value is missing, or a page can't be read. | Blocker | Types the value, or attests the page has none. |
| `OVERHEAD_LABEL_MISMATCH` | The stated % differs from the computed %. | Review | Chooses which governs. |
| `MISSING_REFERENCED_DOC` | A referenced document wasn't uploaded. | Review | Uploads it, or accepts it; dependent terms are marked unverified. |
| `DUPLICATE_ITEM` | The same item is priced in a visit and also listed as invoiceable. | Review | Chooses how it is billed. |

**Not flags: bounded review lists with their own screens**
- **Interpretations** (about 10–20 per contract): overhead scope, payment mode, fee triggers, cap kinds, holdback scope, screen-fail basis, rounding, `appliesFrom`, and every enum value set to `other`.
  - The reviewer picks the answer next to its quote, with nothing preselected.
  - If the pick differs from the model's, both are shown and the reviewer confirms.
  - Today's `AMBIGUOUS_TERM` items land here, marked as ambiguous.
- **Unclassified money terms:** each is acknowledged with one click and carried into Phase 2 as a manual billing item.
- **Sample re-key:** 10 random `confirmed` values per contract, typed without seeing the AI's answer (the 30–60 min review chosen 2026-10-28).
  - If any one is wrong, sign-off is blocked, that class of value is fully reviewed, and an incident is logged.
  - **This is how we measure silent errors in production.**

**Keeping flags few enough to read [8][9]**
1. A flag comes only from conflicting evidence or missing evidence. Never from the model's own confidence, and never from one model disagreeing with another.
2. One flag per root cause. Flags are grouped per item, and arithmetic flags are suppressed when a `VALUE_CONFLICT` explains them.
3. Flag budget per text-PDF contract: median ≤ 10, maximum 25. A flag type with under 50% precision on the held-out set is fixed or removed before go-live.
4. Severity is enforced in the API, not just shown in the UI.
5. Every flag shows the page crop and one sentence explaining the rule. Auditors act on a red flag more often when they understand the test behind it [9].

## 7. Schema evolution

**Decision:** keep the typed schema, add an `unclassified` list, and add `other` to every enum. No general rule language.

**Why not a general rule model:**
- Phase 2 rules compute from typed fields.
- A general rule language moves the hard part, interpreting the clause, into an expression the accountant can't review.
- About 20 core term types cover most of the money in a CTA [11]. The long tail is named invoiceables, and the existing `Invoiceable` shape already absorbs them.

**Schema version 2 adds**
- `"other"` plus an `asWritten` string on every enum: deadline kind, fee trigger, cap kind, overhead `appliesTo`, basis, payment mode and frequency. The prompt drops "only these kinds".
- `unclassified: { label, quote, page, amounts[], pct?, days?, note, prov }[]`.
- `perPatientTotals[].visitCodes`, which replaces the block heuristic.
- Later, by the 2-contract rule: holdback and overhead as attributes of each line, and more than one holdback.

**Promoting a term to a real field**
1. The same kind of unclassified term appears in 2 or more contracts (the user's rule).
2. Schema version N+1 gets a typed field, a prompt section, a check and answer-key fields.

**Signed versions are never rewritten:**
- Readers convert version N to N+1 by adding the new field marked `notReviewed`.
- Phase 2 lists `notReviewed` and unclassified items as manual billing items, and does not run the new rules on them.
- To bring an old study up to date: open a reclassification draft (from its unclassified list, or a fresh run), review the diff, and sign. The audit log records it as a reclassification, not an amendment; `appliesFrom` is unchanged.

## 8. Removing the tuning to these 4 contracts

| Rule | Where | Fitted to | Replacement |
|---|---|---|---|
| "e.g. PPD, IQVIA, Synteract" | `prompts.ts:93`, `rulebook.ts:37` | CROs in the 4 contracts | The definition only. |
| Ambiguity examples: overhead on stipends, site costs including overhead | `prompts.ts:106` | HCWC, Shah | General wording: "a money term whose wording allows two different billing outcomes". |
| Deadlines "only these kinds" | `prompts.ts:102`, `rulebook.ts` `Deadline.kind` | The 4 contracts' deadline kinds; **drops every other kind** | `other` plus `asWritten`. |
| `blocks_with_reauth` and its wording | `rulebook.ts:129`, `prompts.ts:99` | One contract's cap | Keep the enum value (it's real), add `other`, drop the wording. |
| "mammograms…", rows in the invoiceable section | `prompts.ts:117` | HCWC layout | "Rows not included in the printed visit total." Arithmetic now checks which rows the model left out of the total. |
| "scanned images, often tilted or sideways" | `prompts.ts:58` | The 4 test files | Neutral wording. |
| Per-patient check: block exclusion, column-sum escape, ±tolerance × number of visits | `checks.ts:101–115` | McAllen | Exact check against the model's `visitCodes`. |
| Re-read threshold `max(3, 25% of visits)` plus the cost test | `extract.ts:244–247` | HCWC (44 of 44 visits failed) | Re-read with the strongest model whenever conflicts exist; never skip to save cost. |
| AI_DISAGREEMENT not comparing labels | `checks.ts:442` | A patch for noise | Removed with the cross-read; labels move to the interpretations list. |
| DUPLICATE_ITEM skipped when any cell is invoiceable | `checks.ts:152` | Shah | Keep only if it holds on the held-out set; either way it stays Review-level. |
| Comparing subtotals as one combined sum | `checks.ts:82–97` | Shah | Keep: the rule itself is general. |
| `dct` → "discovery clinical trials" | `checks.ts:367` | Our own site name | Keep (constant across contracts). |

**Rule from now on:** no prompt or check may name a sponsor, CRO, drug, procedure or layout taken from a specific contract. A test greps the prompts for names that appear in the answer keys.

## 9. Security and trust boundaries

| Boundary | Decision |
|---|---|
| Contract text is untrusted input to the model | The model has no tools and returns schema-constrained output. A prompt injection can at most produce wrong values, and a wrong value can't pass I1/I2 because it must match visible text. `HIDDEN_TEXT` covers white or tiny text, the main attack [12]. A disagreement between the vision read and the text layer catches remapped fonts [12]. |
| Model output shown in the UI | Quotes and labels are rendered as plain text only: no HTML, no model-supplied links. |
| Bank details | **Mask bank-detail spans (ABA/routing/SWIFT/IBAN/account plus a digit run) in page images before they are sent**, using the text-layer boxes, instead of trusting the prompt. Keep the scrub of long digit runs after parsing. Bank spans stay out of the inventory and are never stored. |
| Patient data | Only contracts go to the AI. A test asserts that only `packages/extraction` imports a model SDK. CTMS imports never go near it. |
| Vendors | Anthropic only: delete the OpenAI client. Before go-live, confirm two things: (a) DCT's Anthropic terms and data retention (ZDR if available); (b) that sponsors' CTA confidentiality clauses allow disclosure to a processor bound by confidentiality. (b) is a legal question, not an engineering one. |
| What is stored per version | Source PDFs (sha256), rulebook, ledger, inventory, raw model outputs, model IDs and prompt hash. The sign-off record stores the hashes of all of these, so tampering is detectable. No contract text in logs (already true). Login before any hosting (already decided). |

## 10. Test plan and acceptance bar

**Material**
- **The 4 tuned contracts:** get the e-signed originals of McAllen, HCWC and Shah (COPD's exists). The 4 scans stay as the scan-mode tests.
- **Held-out set:** 5–10 past DCT contracts as text PDFs, plus 1–2 scans. Split it in two:
  - **Development set:** we look at failures and fix generically.
  - **Lockbox:** 2–3 contracts the user keeps. Nobody, Claude included, opens them before the final run. They are run once, with no fixes afterwards. **This is the proof that doesn't depend on trusting us.**

**Answer keys**

Keys are written before any run, by the user and by Claude separately; the user decides disagreements. Two changes:
- **Claude's key is built from the text layer,** not from images with the production prompts. The same model family has the same blind spots [1][2], so the user's key is the authority.
- **Both keys are checked for completeness against the code's inventory:** every money-relevant span is either in a key or marked "not a payment term" by the user.

Keys cover full grid rows, interpretations and unclassified terms.

**Metrics** (per contract and pooled; the user labels each flag real or false)

| # | Metric | Gate |
|---|---|---|
| 1 | Silent errors: wrong in the draft AND `confirmed` (no flag, not on a review list) | **0** |
| 2 | Silent misses: a key item missing from the rulebook AND not raised as `UNACCOUNTED_TERM` or unclassified | **0** |
| 3 | $ wrong or missed silently (annualized $ of rows 1 and 2) | **$0** |
| 4 | Field accuracy before review, per family (grid cells, fees, rules, interpretations) | Report; target ≥ 98% on text PDFs |
| 5 | Flags per contract; precision per flag type | Median ≤ 10, max 25; precision ≥ 50% |
| 6 | Share of values `confirmed` automatically (text PDFs) | Target ≥ 95% |
| 7 | Review minutes per contract (timed on the lockbox) | Median ≤ 60 |
| 8 | Cost per contract, p50 and p95 | Report; runaway cap $20 |

**What zero errors proves:**
- With N confirmed values and 0 silent errors, the 95% upper bound on the silent-error rate is 3/N. Six contracts of about 800 values each gives N ≈ 4,800, so the bound is ≤ 0.06%.
- It proves nothing about a layout we haven't seen yet. The 10-value sample on every production contract covers that.

**Gate for each production contract:** I1–I6 hold, the sample re-key passes, and someone other than the corrector signs whenever money values were corrected. That means **turning maker-checker on**.

**Evidence after go-live**
- **Phase 2:** "billed rate ≠ contract rate" works in both directions; either the bill or the rulebook can be wrong.
- **Phase 3:** each sponsor payment line either confirms a rate (`confirmed_by_payment`) or raises `RATE_CONTRADICTED_BY_PAYMENT`, which reopens that value.
- **Open item:** if DCT keeps a typed price list (Clinical Conductor or a spreadsheet; still unanswered), reconcile it at sign-off as `PRICE_LIST_MISMATCH`. It is the cheapest double entry available.

## 11. Cost per contract

Estimates for a text PDF, to be measured on the held-out set.

| Step | Cost |
|---|---|
| Text layer, binding, coverage | $0 |
| Page sorting (Haiku) | < $0.01 |
| Terms: all pages, 1568 px images, 3 cached calls | Sonnet ~$0.2–0.4 · Opus ~$0.4–0.8 |
| Grids: 400 DPI tiles | Sonnet ~$0.2–1.0 · Opus ~2× |
| Conflict re-reads (strongest model) | $0–2 |
| **Typical total** | **~$1–3 with Opus as the reader; ≤ $5 with re-reads**. Saved Sonnet runs measured $0.45–1.58 for the primary read. |

- At 3 contracts a month that is about $3–15 a month. **Reviewer time (30–60 min) is the main cost, so tune for fewer flags, not fewer tokens.**
- Choose the reader model on the held-out set by flags per contract and review minutes. The gate, not the model, is what keeps silent errors at 0; the model changes how much review is needed.

## 12. Build order

| # | Step | Why it's at this point |
|---|---|---|
| 0 | Gather material: the 3 missing originals, the development set and the lockbox; write the answer keys before any run. | Keys written after a run aren't blind. |
| 1 | `TextLayer`: visible spans with boxes, page text-source check, hidden text, money inventory, bank masking. Pure code, tested on the COPD original. | Every later step depends on it. |
| 2 | `Binder` and the ledger: grid row bands, quote matching, re-pointing wrong page citations. Replaces `TEXT_LAYER_MISMATCH`. Expected on COPD: all 593 cells end up `confirmed` or `conflict`, with none passing on page membership alone. | Most of the safety comes from here. |
| 3 | Coverage: `UNACCOUNTED_TERM` and the absence sweep; schema v2 (`other`, `unclassified`, `visitCodes`); read every page; remove "only these kinds". | Closes the silent-drop paths. |
| 4 | Delete the cross-read, the OpenAI client, `LOW_CONFIDENCE`, `AI_DISAGREEMENT` and cost-based skipping; turn the budget guard into a $20 runaway cap. | Removes noise; less code. |
| 5 | API gate: I1–I6 at sign-off, clearance rules per severity, maker-checker on. | Makes the guarantee enforceable. |
| 6 | Review UI: blind typed clearance next to the page crop, interpretations list, unclassified list, 10-value sample, dismissing whole sections. | Where reviewer time is won or lost. |
| 7 | Prompt and check cleanup (§8); scan mode (arithmetic, blind entry, page attestation). | |
| 8 | Run the development set → fix generically → run the lockbox once → go or no-go against the gates in §10. | |
| 9 | Phase 2/3 hooks: manual billing items, `RATE_CONTRADICTED_BY_PAYMENT`, and price-list reconciliation if a list exists. | |

## Sources

These came from the research passes; the strength tag is the research agent's.

1. Kim et al., *Correlated Errors in Large Language Models*, ICML 2025. https://arxiv.org/abs/2506.07962 (strong)
2. *Great Models Think Alike and this Undermines AI Oversight*, ICML 2025. https://arxiv.org/abs/2502.04313 (strong)
3. ExtractConf: confidence for field extraction on DocILE. https://arxiv.org/abs/2606.24420 (weak: a single-author preprint, but the closest match to our setup)
4. Meta-analysis of data-processing error rates (93 papers). https://pmc.ncbi.nlm.nih.gov/articles/PMC10775420/ (strong)
5. Barchard & Pace, visual checking vs double entry. https://online210.psych.wisc.edu/wp-content/uploads/PSY-210_Unit_Materials/PSY-210_Unit05_Materials/Barchard_abstract_CHB_2011.pdf (moderate)
6. Automation bias in reviewing AI-extracted numbers, HDSR. https://hdsr.mitpress.mit.edu/pub/nrcn4h7d/release/1 (moderate)
7. Claude PDF support (page text sent alongside images). https://platform.claude.com/docs/en/build-with-claude/pdf-support (vendor)
8. Reminder acceptance falls 30% per additional reminder. https://bmcmedinformdecismak.biomedcentral.com/articles/10.1186/s12911-017-0430-8 (strong). Drug-alert override rates 49–96%: https://pmc.ncbi.nlm.nih.gov/articles/PMC1447540 (strong)
9. Auditors are less skeptical with high false-positive tools: https://scholarspace.manoa.hawaii.edu/handle/10125/70450. They escalate red flags from inherited tests less often: https://news.ncsu.edu/2025/09/blind-spot-for-auditors/ (moderate)
10. AWS A2I closed to new customers: https://docs.aws.amazon.com/sagemaker/latest/dg/a2i-json-humantaskactivationconditions-textract-example.html. Google Document AI human review deprecated: https://docs.cloud.google.com/document-ai/docs/deprecation (strong)
11. CTA money-term taxonomy: SCRS Site Invoiceables Guide https://myscrs.org/wp-content/uploads/2026/05/SCRS-Site_Invoiceables_Guide_Preview.pdf; ACTA https://www.rochester.edu/orpa/_assets/word/form_ACTA.docx; a CRO payment exhibit https://www.sec.gov/Archives/edgar/data/1946563/000121390024080313/ea021474701ex10-3_60degrees.htm
12. Hidden-text prompt injection in PDFs: https://arxiv.org/abs/2509.10248. Malicious-font text/glyph mismatch: https://arxiv.org/abs/2505.16957 (weak). Spotlighting: https://arxiv.org/abs/2403.14720
