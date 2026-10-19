# DocDiff Reviewer

Compare two versions of a document side by side, and get back a review memo that says
**what changed** and **which changes actually matter**.

A small, self-contained proof of concept. No cloud account, no database, no build step,
no dependencies: `node server.js` and you are running.

```
before.md ─┐
           ├─► [1] parse into blocks ─► [2] align + diff ─► changes.json
after.md  ─┘                            (no model, always exact)
                                                              │
                                                              ▼
              [4] review memo ◄── [3] classify each change (rules, or a model)
```

---

## The problem it solves

You have `policy-v1.pdf` and `policy-v2.pdf`, or a contract redline, or this quarter's
report specification next to last quarter's. Somebody has to answer one question:
*what actually changed, and does any of it matter?*

Pasting both documents into a chat window is easy but unreliable. The model paraphrases
instead of quoting, invents differences that are not there, skips anything buried in a
table, and cannot tell a capitalisation fix from a weakened legal obligation. You end up
checking the "diff" against the documents by hand, which was the whole job.

This project splits that job at the point where each technique is strong:

| Question | Handled by | Why |
|---|---|---|
| What changed, exactly? | Deterministic code | Must never be guessed. Exact, instant, free. |
| How much does it matter? | Rules, or an LLM | Judgement, not extraction. |
| What should a human do? | Synthesised memo | Turns findings into decisions. |

---

## How it works

**Step 1 — Parse into blocks.** Both documents are split into addressable blocks:
headings, paragraphs, list items, table rows. Every block gets a stable ID
(`before-7`, `after-7`) and remembers which section it belongs to.

**Step 2 — Align, then diff.** Blocks are matched up first, so inserting one paragraph
near the top does not mark the rest of the document as changed. Inside each changed
block, a word-level diff shows exactly which words moved.

**Step 3 — Classify each change.** Every changed region is judged for category
(`numbers`, `obligation`, `definition`, `scope`, `formatting`, `wording`) and
materiality (`high`, `medium`, `low`). This runs on plain rules by default. If you add an
API key it runs on a language model instead, and silently falls back to the rules if a
request fails.

**Step 4 — Write the memo.** Verified findings are assembled into a short Markdown review:
summary counts, a table of changes, detail on the ones that matter, and the questions a
reviewer should ask.

---

## Quick start

Requirements: **Node.js 20.12 or newer.** Nothing else.

```bash
git clone https://github.com/<your-username>/docdiff-reviewer.git
cd docdiff-reviewer
npm start
```

There is no `npm install` step: the app has zero runtime dependencies.

Open <http://localhost:4310>, click **Load sample** above each text area, then
**Compare documents**.

> No screenshot is committed yet. Capture the sample comparison at 1280px wide, save it as
> `docs/screenshot.png`, and embed it here. Tracked as `M8-2` in
> [REQUIREMENTS.md](REQUIREMENTS.md).

### What you should see

Comparing `samples/policy-v1.md` with `samples/policy-v2.md` produces seven changes:

| Section | What changed | Materiality |
|---|---|---|
| 2. Approved locations | `must` became `should`: the obligation was weakened | high |
| 3. Password and authentication | password rotation `60` → `90` days | high |
| 5. Reporting a lost device | report a lost device within `24` → `48` hours | high |
| 6. Data residency | a new binding section was added | high |
| 4. Device requirements | screen lock `10` → `5` minutes | medium |
| 4. Device requirements (table) | the same `10` → `5` in the control table | medium |
| 1. Purpose | a comma was added; capitalisation also changed | low |

That last row is worth a look. `This policy` became `This Policy` and the tool **does not**
report it, because comparison is case-insensitive on purpose. Only the comma shows up.
Suppressing noise like that is most of the value.

### Command line

```bash
# check what engine is active
curl http://localhost:4310/api/health

# compare two files
curl -s http://localhost:4310/api/compare \
  -H 'content-type: application/json' \
  -d "{\"before\": $(jq -Rs . < samples/policy-v1.md), \"after\": $(jq -Rs . < samples/policy-v2.md)}" \
  | jq -r .memo
```

### Tests

```bash
npm test
```

Six assertions cover the alignment rules the diff engine depends on, including the two that
matter most: an inserted paragraph must not mark the rest of the document as changed, and a
capitalisation-only edit must not be reported.

---

## Turning on a language model (optional)

The app is fully useful without one. The rules engine is deterministic and free, and on
this sample it already finds every material change.

A model helps with the judgement calls rules cannot see. The clearest example is in the
sample: the backup row changed from **Weekly** to **Daily**. The rules engine reports that
as a low-materiality wording change, because no digit changed. A model reads it as a
material change to a recovery objective. Both answers are honest; only one is what a
reviewer would want.

```bash
cp .env.example .env
# edit .env and set OPENAI_API_KEY
npm start
```

Any OpenAI-compatible endpoint works, including Azure OpenAI, OpenRouter, and a local
Ollama server. Set `OPENAI_BASE_URL` and `MODEL` accordingly. Set `ENABLE_LLM=0` to force
the rules path back on.

Classification runs four requests at a time, each with a 30 second timeout. If a request
fails, that one change falls back to rules and says so in the UI, so a bad key or a rate
limit never loses the comparison.

---

## Project layout

| Path | Responsibility |
|---|---|
| `server.js` | Zero-dependency HTTP server, three routes, static files |
| `src/diff.js` | Parse, align, word diff. Contains no model calls at all. |
| `src/agent.js` | Change classification: rules engine plus optional model backend |
| `src/report.js` | Builds the Markdown review memo from findings |
| `public/` | The web UI: plain HTML, CSS and ES modules |
| `test/` | Alignment and diff assertions, using Node's built-in test runner |
| `samples/` | Two versions of a policy document used in the demo |
| `docs/` | Architecture notes and screenshots |
| `REQUIREMENTS.md` | Scoped roadmap: every task is sized to an afternoon or less |

### API

| Route | Purpose |
|---|---|
| `GET /api/health` | Reports which classification engine is active |
| `POST /api/compare` | `{ before, after, beforeName?, afterName?, useLLM? }` → findings, stats, memo |
| `GET /samples/:file` | Serves the demo documents |

`POST /api/compare` answers `400` when either document is missing and `422` when a document
is too large to align, with a readable explanation in both cases.

---

## Design principles

1. **Deterministic first.** Anything that can be computed exactly is computed exactly.
   The model is only ever asked to judge, never to report what changed.
2. **Quote, do not paraphrase.** Every finding carries block IDs and verbatim text, so a
   reviewer can check it in seconds.
3. **Degrade, do not fail.** No key, no network, a timeout, a malformed model response:
   the comparison still completes and the UI says which engine produced each finding.
4. **Small surface.** Zero dependencies, no build step, no database. You can read the whole
   thing in one sitting.

---

## Known limitations

These are deliberate choices for a proof of concept, not oversights.

- **Markdown and plain text only.** PDF and Word need an extraction layer first, and
  scanned PDFs need OCR before any of this is meaningful. See `M7` in the roadmap.
- **Capitalisation-only edits are invisible.** Comparison is case-insensitive, so
  `policy` → `Policy` is not reported. This is intentional noise suppression, but it does
  mean a change in a proper noun's casing will not be flagged.
- **The rules engine reads numbers, not intent.** `Weekly` → `Daily` looks like a wording
  tweak to a regex. Use the model path for documents where that matters.
- **Single language.** The modal verbs and limit keywords are English-only.
- **Nothing is stored.** No history, no users, no database. Two documents in, one memo out.
- **Not hardened for the internet.** No authentication, no rate limiting. Run it locally.

---

## Roadmap

[REQUIREMENTS.md](REQUIREMENTS.md) lists the next steps, each with acceptance criteria and a
size estimate. The short version:

- A verification pass that re-checks each finding and drops false positives (`M4`)
- DOCX and PDF input (`M7`)
- A labelled test set so classification quality is measured, not asserted (`M6`)
- Side-by-side scrolling review view with accept/reject per card (`M8`)

---

## License

MIT. See [LICENSE](LICENSE).
