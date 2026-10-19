# Architecture

Notes for anyone extending this project. The whole application is about six hundred lines,
so this document explains the *why* rather than restating the code.

---

## Shape of the system

```
             ┌───────────────────────────────────────────────────────────────┐
  HTTP       │  server.js                                                    │
  request ──►│    POST /api/extract  →  extractText()  (PDF, DOCX, text)     │
             │    POST /api/compare  →  compare() → classifyChanges()        │
             │                       →  buildMemo()                          │
             └───────────┬──────────────────────┬────────────────────────────┘
                         │                      │
                    src/diff.js            src/agent.js
                  (deterministic)          (judgement)
                         │                      │
                         └──── findings ────────┴──► src/report.js
```

Five modules, one direction of data flow, no circular imports. `src/diff.js` imports nothing
from the rest of the app and makes no network calls, which is what makes it testable in
isolation and trustworthy in the middle of a pipeline that does call a model.

---

## Data shapes

**Block** — the unit of comparison. Produced by `parseBlocks()`.

```js
{
  id: "before-5",        // stable, human-readable, stable across runs
  kind: "heading",       // heading | paragraph | list | table
  section: "2. Approved locations",  // nearest heading above this block
  text: "Employees must work...",    // original text, shown to humans
  norm: "employees must work..."     // lowercased, whitespace collapsed
}
```

`text` is what the user sees. `norm` is what the algorithm compares. Keeping both means a
capitalisation change cannot alter alignment, and nothing is ever shown that was not in the
source.

**Change** — one region where the documents differ. Produced by `compare()`.

```js
{
  id: "c3",
  type: "modified",       // modified | added | removed
  section: "3. Password and authentication",
  beforeIds: ["before-7"],
  afterIds: ["after-7"],
  before: "All employees must rotate...60 days...",
  after: "All employees must rotate...90 days...",
  segments: [             // renderable word-level diff
    { op: "eq",  text: "All employees must rotate their account passwords every " },
    { op: "del", text: "60" },
    { op: "ins", text: "90" },
    { op: "eq",  text: " days." }
  ]
}
```

**Finding** — a change plus judgement. Produced by `classifyChanges()`.

```js
{
  ...change,
  category: "numbers",        // numbers | obligation | definition | scope | formatting | wording
  materiality: "high",        // high | medium | low
  rationale: "A controlled limit changed in \"...\": 60 -> 90.",
  source: "rules"             // or "model:gpt-4o-mini", or "rules (model unavailable: ...)"
}
```

`source` is not decoration. When someone questions a classification, the answer is either
"the rules said so, here is the rule" or "the model said so, here is the request". Never a
guess about which path ran.

---

## Extraction is the lossy boundary

Everything before `parseBlocks()` is format-specific and everything after it is not. That
boundary is `src/extract.js`, and it is the only file that imports `mammoth` or `pdfjs-dist`.

Both extractors aim to produce **Markdown-shaped text**, not plain prose, because the block
parser keys off Markdown conventions:

- **DOCX** is converted to HTML by mammoth, then translated: headings become `#`, list items
  become `-`, table rows become pipe-delimited rows. This preserves section context, which is
  what lets a finding say "3. Password and authentication" instead of "somewhere in the
  document".
- **PDF** has no structure to recover, so it is inferred. Text items are grouped into visual
  lines by their vertical position, lines are merged into paragraphs when the gap between them
  is smaller than `1.6 x` the median font size, and a line set in a noticeably larger font is
  emitted as a heading. It is a heuristic, and it is why PDF fidelity is "good" rather than
  "exact".

The rule that keeps this honest: **when extraction finds almost nothing, say so**. A scanned
PDF extracts to an empty string, which would compare as "no changes" and look like a pass. So
`extractText()` returns a `warning` whenever the result is under 40 characters, and the UI
shows it before the user presses compare.

---

## Why align before diffing

A naive line diff on two document versions is wrong in a specific and destructive way: one
inserted paragraph shifts every subsequent line, so the tool reports the rest of the document
as rewritten. Reviewers see hundreds of changes where there are three, and stop reading.

The fix is to align first. `compare()` runs a longest-common-subsequence over *blocks*, then
only looks inside blocks that were not matched. Unmatched blocks between two matches form a
gap; blocks inside a gap are paired by position, so a reworded paragraph is reported as one
`modified` change rather than one deletion plus one addition. Anything left over in the gap
becomes a single `added` or `removed` region, which is why a new section with its heading is
one card.

Cost is `O(n·m)` in blocks, which is fine for documents of a few hundred blocks. There is an
explicit guard (`250,000` block pairs) that returns a readable error instead of stalling.

---

## Why the rules engine is the default

Three reasons, in order of importance:

1. **It cannot be unavailable.** No key, no network, no quota, no latency. A demo that dies
   because of a rate limit is not a demo.
2. **It is inspectable.** Every classification maps to a rule you can read, which makes
   disagreements productive: either the rule is wrong or the document really did change.
3. **It sets the floor.** The model path has to beat it to be worth its latency and cost.
   Today it wins on intent (`Weekly` → `Daily`) and loses on nothing important.

The model path is opt-in, concurrency-limited, and wrapped so that any failure is contained
to the single change that hit it.

---

## Extension points

| To change | Edit | Note |
|---|---|---|
| How blocks are detected | `classifyKind()` in `src/diff.js` | Markdown conventions today; everything downstream is format-agnostic |
| Support a new file type | `extractText()` in `src/extract.js` | Return Markdown-shaped text and nothing else in the app needs to change |
| How changes are scored | `classifyWithRules()` in `src/agent.js` | Ordered strongest-signal-first; add rules above the generic ones |
| Which model is used | `.env` only | Any OpenAI-compatible endpoint |
| The memo wording | `src/report.js` | Pure string assembly from findings, no I/O |
| The look | `public/styles.css` | Single stylesheet, CSS variables at the top |

The seam that matters is `src/diff.js` → `findings`. Anything that produces findings in that
shape can replace the front half, including a completely different extraction strategy.

---

## Deliberate tradeoffs

- **Block-level units, not character offsets.** A change is located by block, not by page and
  line. Cheaper, and enough for review; not enough for a legal redline.
- **Whole-document load.** Both documents are held in memory. Fine to about 5 MB, which the
  server enforces.
- **No persistence.** Every request is independent. Adding history would mean a database and
  a migration story, and neither is needed to prove the idea.
- **Rules are English-only.** Modal verbs and limit keywords are hard-coded. Localisation
  would need a per-language rule set, not a translation of the current one.
- **The UI is server-rendered nothing.** It is static files plus `fetch`. No framework,
  because a framework would be more code than the application it serves.

---

## What to test first

If you change the diff engine, the highest-value tests are:

1. Identical documents produce zero changes.
2. An inserted paragraph at the top produces exactly one added region.
3. A changed number produces exactly one modified region whose segments contain one `del`
   and one `ins`.
4. A capitalisation-only edit produces zero changes.
5. A new heading plus paragraph produces one added region with two block IDs.

Each of these is a line or two against `compare()`, and together they cover the failure modes
that make reviewers distrust a diff tool.
