/**
 * Change classification: how much does each changed region actually matter?
 *
 * Two interchangeable backends:
 *   1. Rules (default)  - no network, no key, instant, fully predictable.
 *   2. Language model   - enabled only when OPENAI_API_KEY is set.
 *
 * Both return the same shape, so the rest of the app never knows which ran.
 */

const CATEGORIES = ['numbers', 'obligation', 'definition', 'scope', 'formatting', 'wording'];
const MATERIALITY = ['high', 'medium', 'low'];
const NUMBER_RE = /-?\d+(?:[.,]\d+)?/g;
const MODAL_RE = /\b(must|shall|should|may|can|will|required|prohibited|forbidden|mandatory)\b/g;
const HARD_LIMIT_RE = /%|\$|\bdays?\b|\bhours?\b|limit|threshold|maximum|minimum|penalty/;
const DEFINITION_RE = /\bmeans\b|\bis defined as\b|\brefers to\b|^[^:]{3,60}:/;

/** Numbers compared as strings, order preserved: 60 -> 90 is a change. */
function extractNumbers(text) {
  return (String(text).match(NUMBER_RE) ?? []).map((n) => n.replace(',', '.'));
}

function modalSet(text) {
  return new Set(String(text).toLowerCase().match(MODAL_RE) ?? []);
}

function contentOnly(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const RANK = { high: 0, medium: 1, low: 2 };

/**
 * Rule-based classification. Ordered from strongest signal to weakest, so a
 * change that alters a legal limit is never reported as a wording tweak.
 */
export function classifyWithRules(change) {
  const beforeNumbers = extractNumbers(change.before);
  const afterNumbers = extractNumbers(change.after);
  const numbersChanged = beforeNumbers.join('|') !== afterNumbers.join('|');

  const beforeModals = modalSet(change.before);
  const afterModals = modalSet(change.after);
  const modalDelta = [...new Set([...beforeModals, ...afterModals])].filter(
    (m) => beforeModals.has(m) !== afterModals.has(m),
  );

  const reference = change.after || change.before;

  if (change.type === 'added' || change.type === 'removed') {
    const verb = change.type === 'added' ? 'added' : 'removed';
    const hasObligation = modalSet(`${change.before} ${change.after}`).size > 0;
    return {
      category: 'scope',
      materiality: hasObligation ? 'high' : 'medium',
      rationale: `A ${hasObligation ? 'binding' : 'non-binding'} clause was ${verb}: ${quote(reference, 90)}`,
      source: 'rules',
    };
  }

  if (numbersChanged) {
    const tight = HARD_LIMIT_RE.test(`${change.before} ${change.after}`);
    return {
      category: 'numbers',
      materiality: tight ? 'high' : 'medium',
      rationale: `${tight ? 'A controlled limit' : 'A figure'} changed in ${quote(reference)}: ${beforeNumbers.join(', ') || 'none'} -> ${afterNumbers.join(', ') || 'none'}.`,
      source: 'rules',
    };
  }

  if (modalDelta.length > 0) {
    return {
      category: 'obligation',
      materiality: 'high',
      rationale: `How binding this is changed in ${quote(reference)} (${modalDelta.join(' -> ')}).`,
      source: 'rules',
    };
  }

  if (DEFINITION_RE.test(normalizeStart(change.before)) || DEFINITION_RE.test(normalizeStart(change.after))) {
    return {
      category: 'definition',
      materiality: 'medium',
      rationale: `A defined term was reworded in ${quote(reference)}.`,
      source: 'rules',
    };
  }

  if (contentOnly(change.before) === contentOnly(change.after)) {
    return {
      category: 'formatting',
      materiality: 'low',
      rationale: `Only punctuation changed in ${quote(reference)}. No meaning change.`,
      source: 'rules',
    };
  }

  return {
    category: 'wording',
    materiality: 'low',
    rationale: `Wording changed in ${quote(reference)} without affecting a figure or an obligation.`,
    source: 'rules',
  };
}

function normalizeStart(text) {
  return String(text).trim().toLowerCase();
}

/** Short verbatim snippet, so findings stay anchored to real text. */
function quote(text, max = 70) {
  return `"${truncate(text, max)}"`;
}

function truncate(text, max) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/* ------------------------------------------------------------------ */
/* Optional language-model backend                                     */
/* ------------------------------------------------------------------ */

const LLM_TIMEOUT_MS = 30_000;
const LLM_CONCURRENCY = 4;

const SYSTEM_PROMPT = [
  'You review edits between two versions of a single block of a business document.',
  'Reply with one JSON object and nothing else, with exactly these keys:',
  'category, materiality, rationale.',
  'category is one of: numbers, obligation, definition, scope, formatting, wording.',
  'materiality is one of: high, medium, low.',
  'Rules: judge only the text given. Never invent changes that are not in the text.',
  'High means the change alters an obligation, a limit, a deadline, or scope.',
  'Low means cosmetic or purely clarifying wording.',
  'rationale is one sentence, at most 25 words, describing the practical effect.',
].join(' ');

export function llmConfig(env = process.env) {
  const key = env.OPENAI_API_KEY?.trim();
  const enabled = Boolean(key) && env.ENABLE_LLM !== '0';
  return {
    enabled,
    key,
    baseUrl: (env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: env.MODEL?.trim() || 'gpt-4o-mini',
  };
}

async function classifyWithModel(change, config) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.key}`,
    },
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            section: change.section,
            type: change.type,
            before: change.before,
            after: change.after,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`model request failed with ${response.status}`);
  }

  const payload = await response.json();
  const raw = payload?.choices?.[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw);

  const category = CATEGORIES.includes(parsed.category) ? parsed.category : null;
  const materiality = MATERIALITY.includes(parsed.materiality) ? parsed.materiality : null;
  if (!category || !materiality) throw new Error('model returned an unexpected shape');

  return {
    category,
    materiality,
    rationale: String(parsed.rationale ?? '').slice(0, 400) || 'Model reported a change without detail.',
    source: `model:${config.model}`,
  };
}

async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Classify every change and return findings sorted by importance.
 * The model path degrades to rules per item, so one bad request cannot
 * take down the whole comparison.
 */
export async function classifyChanges(changes, options = {}) {
  const config = llmConfig();
  const useLLM = options.useLLM !== false && config.enabled;

  const findings = await mapWithLimit(changes, useLLM ? LLM_CONCURRENCY : 16, async (change) => {
    const fallback = classifyWithRules(change);
    if (!useLLM) return { ...change, ...fallback };

    try {
      const judgement = await classifyWithModel(change, config);
      return { ...change, ...judgement };
    } catch (error) {
      return {
        ...change,
        ...fallback,
        source: `rules (model unavailable: ${error.message})`,
      };
    }
  });

  return {
    findings: findings.sort((a, b) => RANK[a.materiality] - RANK[b.materiality]),
    engine: useLLM ? `model:${config.model}` : 'rules',
  };
}
