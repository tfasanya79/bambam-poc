# DocDiff Reviewer

Compare two versions of a document side by side, and get back a review memo that says
**what changed** and **which changes actually matter**.

Runs as a small local web app. Upload a PDF, a Word file, or paste text; get back a review.
No account, no database, no cloud, and no API key required.

```
before.pdf/docx/md ─┐
                    ├─► [0] extract text ─► [1] parse into blocks ─► [2] align + diff ─► changes
after.pdf/docx/md  ─┘                             (no model, always exact)              │
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

## Quick start

Requirements: **Node.js 20.12 or newer.**

```bash
git clone https://github.com/tfasanya79/bambam-poc.git
cd bambam-poc
npm install
npm start
```

The terminal then prints two addresses:

```
  Local:     http://localhost:4310
  Share:     http://192.168.1.204:4310   (WiFi)
```

Open the **Local** address, click **Sample** above each pane, then **Compare documents**.

The two runtime dependencies (`mammoth` for Word, `pdfjs-dist` for PDF) are used only to
read files into text. The comparison engine itself has none, which is why it works offline.

### Sharing it with your team

The server listens on all interfaces, so a colleague on the same network opens the **Share**
address in their browser. Nothing else to install on their machine.

If the Share address does not load for them, Windows Firewall is blocking inbound
connections to Node. Allow it once:

```powershell
New-NetFirewallRule -DisplayName "DocDiff Reviewer" -Direction Inbound -LocalPort 4310 -Protocol TCP -Action Allow
```

Set `HOST=127.0.0.1` in `.env` to keep it local-only instead.

---

## What you should see

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

The same file pair converted to Word and to PDF produces **the same seven findings**. That is
asserted in `test/extract.test.js`, so it stays true.

---

## Working with real documents

| Format | Support | Notes |
|---|---|---|
| `.docx` | Good | Headings, lists and tables are recovered, so sections stay meaningful |
| `.pdf` | Good for text PDFs | Paragraph breaks are inferred from line spacing; headings from font size |
| `.md`, `.txt` | Exact | Best fidelity, since no extraction is needed |
| Scanned PDF | **Not supported** | Image-only files need OCR first. The app detects this and says so instead of returning an empty diff |

Uploads are capped at 10 MB per document. If extraction finds almost no text, the app warns
you above the compare button rather than quietly reporting "no changes".

Two honest caveats about PDF: complex multi-column layouts and table borders may be read in
the wrong order, and a document with no clear spacing between paragraphs may arrive as one
long block. Check the extracted text in the pane before trusting the diff on a new document
family.

---

## Turning on a language model (optional)

The app is fully useful without one. The rules engine is deterministic and free, and on this
sample it already finds every material change.

A model helps with the judgement calls rules cannot see. The clearest example is in the
sample: the backup row changed from **Weekly** to **Daily**. The rules engine reports that as
a low-materiality wording change, because no digit changed. A model reads it as a material
change to a recovery objective. Both answers are honest; only one is what a reviewer would
want.

```bash
cp .env.example .env
# edit .env and set OPENAI_API_KEY
npm start
```

Any OpenAI-compatible endpoint works, including Azure OpenAI, OpenRouter, and a local Ollama
server. Set `OPENAI_BASE_URL` and `MODEL` accordingly. Set `ENABLE_LLM=0` to force the rules
path back on.

Classification runs four requests at a time, each with a 30 second timeout. If a request
fails, that one change falls back to rules and says so in the UI, so a bad key or a rate
limit never loses the comparison.

---

## Project layout

| Path | Responsibility |
|---|---|
| `server.js` | HTTP server: three routes, static files, LAN binding |
| `src/extract.js` | PDF, Word and text extraction. The only place that knows about file formats |
| `src/diff.js` | Parse, align, word diff. Contains no model calls at all |
| `src/agent.js` | Change classification: rules engine plus optional model backend |
| `src/report.js` | Builds the Markdown review memo from findings |
| `public/` | The web UI: plain HTML, CSS and ES modules |
| `scripts/make-fixtures.mjs` | Regenerates the DOCX and PDF test fixtures from the samples |
| `test/` | Diff and extraction assertions, using Node's built-in test runner |
| `samples/` | Two versions of a policy document used in the demo |
| `docs/` | Architecture notes and screenshots |
| `REQUIREMENTS.md` | Scoped roadmap: every task is sized to an afternoon or less |

### API

| Route | Purpose |
|---|---|
| `GET /api/health` | Reports which classification engine is active |
| `POST /api/extract` | Raw file body plus an `x-filename` header → `{ text, info }` |
| `POST /api/compare` | `{ before, after, beforeName?, afterName?, useLLM? }` → findings, stats, memo |
| `GET /samples/:file` | Serves the demo documents |

`POST /api/extract` answers `415` for an unsupported type, `413` when a file is too large and
`400` when the body is empty. `POST /api/compare` answers `400` when either document is
missing and `422` when a document is too large to align. Every error is a readable sentence.

### Tests

```bash
npm test
```

Nine assertions across two files. They cover the alignment behaviour the diff engine depends
on, and they assert that DOCX and PDF extraction recover exactly the same seven changes as
the Markdown baseline.

```bash
npm run fixtures   # regenerate test/fixtures from samples/*.md
```

---

## Design principles

1. **Deterministic first.** Anything that can be computed exactly is computed exactly.
   The model is only ever asked to judge, never to report what changed.
2. **Quote, do not paraphrase.** Every finding carries block IDs and verbatim text, so a
   reviewer can check it in seconds.
3. **Degrade, do not fail.** No key, no network, a timeout, a malformed model response, or a
   badly scanned PDF: the app says what went wrong and still gives you what it has.
4. **Dependencies at the edges only.** File parsing needs libraries; the comparison engine
   needs nothing.

---

## Known limitations

These are deliberate choices for a proof of concept, not oversights.

- **Scanned PDFs are not supported.** No OCR. The app detects image-only files and says so.
- **Capitalisation-only edits are invisible.** Comparison is case-insensitive, so
  `policy` → `Policy` is not reported. This is intentional noise suppression, but it does
  mean a change in a proper noun's casing will not be flagged.
- **The rules engine reads numbers, not intent.** `Weekly` → `Daily` looks like a wording
  tweak to a regex. Use the model path for documents where that matters.
- **PDF paragraphs are inferred.** Extraction groups text lines by vertical spacing. Unusual
  layouts can merge or split paragraphs.
- **Single language.** The modal verbs and limit keywords are English-only.
- **Nothing is stored.** No history, no users, no database. Two documents in, one memo out.
- **Not hardened for the internet.** No authentication, no rate limiting, no TLS. It is built
  to run on a trusted local network, not to be exposed publicly.

---

## Roadmap

[REQUIREMENTS.md](REQUIREMENTS.md) lists the next steps, each with acceptance criteria and a
size estimate. The short version:

- A verification pass that re-checks each finding and drops false positives (`M4`)
- Accept/reject per change card, so stakeholder feedback is captured (`M7-3`)
- A labelled test set so classification quality is measured, not asserted (`M5`)
- Optional login, if it ever needs to leave the local network

---

## License

MIT. See [LICENSE](LICENSE).
