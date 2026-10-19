# Requirements and roadmap

A scoped backlog for DocDiff Reviewer. Every item is deliberately small: if a task cannot
be finished in an afternoon, it is split until it can.

**How to read this file**

- **Status**: `Done` ships in the current code, `Next` is the immediate queue, `Later` is
  parked on purpose.
- **Size**: `S` is two hours or less, `M` is about half a day, `L` is about a day.
- Each requirement states its own **done when** test, so "finished" is never a judgement call.

---

## Milestone 0 — A repository you can run

| ID | Requirement | Done when | Size | Status |
|---|---|---|---|---|
| M0-1 | Run with one command | `npm start` serves the UI on `http://localhost:4310` with no install step | S | Done |
| M0-2 | Zero runtime dependencies | `package.json` lists no `dependencies`, and the app starts after a fresh clone | S | Done |
| M0-3 | Health endpoint | `GET /api/health` returns the active classification engine | S | Done |
| M0-4 | Clear README | A reader who has never seen the repo can run it and read the output without help | S | Done |
| M0-5 | Sample documents | Two sample files demonstrate every change category in the UI | S | Done |

## Milestone 1 — Exact difference detection

| ID | Requirement | Done when | Size | Status |
|---|---|---|---|---|
| M1-1 | Block parsing | Both documents split into blocks with stable IDs and a section label | S | Done |
| M1-2 | Block alignment before diffing | Inserting a paragraph at the top of a document does not mark later blocks as changed | M | Done |
| M1-3 | Word-level highlighting | Each modified block shows which words were added and removed | S | Done |
| M1-4 | Additions and removals | A new clause with its heading is reported as one change, not two | S | Done |
| M1-5 | Case-insensitive comparison | `This policy` → `This Policy` is not reported as a change | S | Done |
| M1-6 | Size guard | Documents too large to align return `422` with a readable reason instead of hanging | S | Done |

## Milestone 2 — Reviewable output

| ID | Requirement | Done when | Size | Status |
|---|---|---|---|---|
| M2-1 | Change cards | Each change renders with category, materiality, rationale and verbatim before/after text | S | Done |
| M2-2 | Summary counts | The UI shows totals for modified, added, removed, high and medium | S | Done |
| M2-3 | Review memo | A Markdown memo is generated with summary, change table, detail and reviewer questions | M | Done |
| M2-4 | Memo download | The memo can be downloaded as a `.md` file from the UI | S | Done |
| M2-5 | Empty state | Comparing identical documents shows a clear "nothing changed" message | S | Done |
| M2-6 | Screenshot in README | `docs/screenshot.png` shows the sample comparison | S | Next |

## Milestone 3 — Classification

| ID | Requirement | Done when | Size | Status |
|---|---|---|---|---|
| M3-1 | Rules engine | Changes are classified into category and materiality with no network access | M | Done |
| M3-2 | Optional model backend | Setting `OPENAI_API_KEY` switches classification to a model with no code change | M | Done |
| M3-3 | Per-change fallback | A failed model request falls back to rules for that change and labels the source | S | Done |
| M3-4 | Engine visibility | The UI shows which engine produced each card | S | Done |
| M3-5 | Filter by materiality | A reviewer can hide `low` changes in one click | S | Next |
| M3-6 | Tune rules from real documents | Misclassifications found on three real document pairs are fixed in the rules | M | Next |

## Milestone 4 — Trust

The single highest-value addition. Without it, a reviewer who finds one false positive stops
trusting the whole list.

| ID | Requirement | Done when | Size | Status |
|---|---|---|---|---|
| M4-1 | Verification pass | Each finding is re-checked and marked `confirmed` or `suspect` with a reason | M | Next |
| M4-2 | Drop confirmed noise | Once M4-1 exists, `suspect` findings are hidden by default with a toggle to show them | S | Next |
| M4-3 | Evidence required | A finding without a verbatim quote from the documents cannot reach the memo | S | Next |

## Milestone 5 — Measurable quality

| ID | Requirement | Done when | Size | Status |
|---|---|---|---|---|
| M5-1 | Labelled test pairs | Ten document pairs with hand-labelled changes live in `eval/` | M | Next |
| M5-2 | Scoring script | `npm run eval` prints recall on real changes and how many findings a reviewer would accept | M | Next |
| M5-3 | Regression check | The score is recorded in the README and re-run before changing classification logic | S | Later |

## Milestone 6 — Document formats

| ID | Requirement | Done when | Size | Status |
|---|---|---|---|---|
| M6-1 | Word documents | `.docx` uploads are converted to blocks, including table rows | M | Later |
| M6-2 | Text-based PDFs | Text PDFs are extracted to blocks with page numbers kept as section hints | M | Later |
| M6-3 | Scanned PDFs | Out of scope until text extraction is solved; needs OCR, which is a different project | L | Later |
| M6-4 | Drag and drop | Dropping a file on a pane loads it | S | Later |

## Milestone 7 — Beyond two documents

| ID | Requirement | Done when | Size | Status |
|---|---|---|---|---|
| M7-1 | Version history | Three or more versions can be compared, and a clause shows when it first appeared | M | Later |
| M7-2 | Clause library | Changes are classified against a taxonomy the team defines, not free-form categories | L | Later |
| M7-3 | Accept and reject | A reviewer can accept or reject each card, and decisions are exported with the memo | M | Later |
| M7-4 | Reuse the decisions | Accepted and rejected cards become evaluation data automatically | M | Later |

---

## Non-goals

Written down so the scope stays small. These are not "someday" items.

- **Editing documents.** This reads and reports; it never writes back to the source file.
- **Contracts advice.** Materiality is a prompt for a human to look, not a legal opinion.
- **Always-on hosting.** A local process is the right shape for a proof of concept.
- **Accounts and permissions.** No user model, no roles, no sharing.
- **Multi-tenant storage.** Nothing is persisted between runs.
- **General-purpose chat.** This is one job done well, not an assistant.

---

## Definition of done for the POC

The proof of concept is considered proven when all of the following are true:

1. A reviewer who did not build it can run it from the README with no help.
2. On the sample pair, every material change is found, and nothing is reported that is not
   in the documents.
3. On one real document pair from the reviewer's own work, they find at least one change
   they would otherwise have missed.
4. The memo is short enough to read in two minutes.
5. With no API key and no network, the app still completes a comparison with useful output.

Items 1, 2, 4 and 5 hold today. Item 3 needs a real document pair: pick one this week.
