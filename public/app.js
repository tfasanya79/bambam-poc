/** Front-end glue: collect two documents, post them, render the review. */

const $ = (selector) => document.querySelector(selector);

const beforeEl = $('#before');
const afterEl = $('#after');
const compareBtn = $('#compare');
const statusEl = $('#status');
const resultsEl = $('#results');
const statsEl = $('#stats');
const cardsEl = $('#cards');
const memoEl = $('#memo');
const engineEl = $('#engine');
const downloadBtn = $('#download');

let beforeName = 'before.md';
let afterName = 'after.md';
let lastMemo = '';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function syncButton() {
  compareBtn.disabled = !(beforeEl.value.trim() && afterEl.value.trim());
}

/* ---------------- engine badge ---------------- */

fetch('/api/health')
  .then((response) => response.json())
  .then((data) => {
    engineEl.textContent = `engine: ${data.engine}`;
  })
  .catch(() => {
    engineEl.textContent = 'engine: offline';
  });

/* ---------------- inputs ---------------- */

beforeEl.addEventListener('input', syncButton);
afterEl.addEventListener('input', syncButton);

document.querySelectorAll('[data-sample]').forEach((button) => {
  button.addEventListener('click', async () => {
    const version = button.dataset.sample;
    setStatus('Loading sample…');
    try {
      const response = await fetch(`/samples/policy-${version}.md`);
      if (!response.ok) throw new Error('Sample not found');
      const text = await response.text();
      if (version === 'v1') {
        beforeEl.value = text;
        beforeName = `policy-v${version}.md`;
      } else {
        afterEl.value = text;
        afterName = `policy-v${version}.md`;
      }
      syncButton();
      setStatus('');
    } catch (error) {
      setStatus(error.message, true);
    }
  });
});

function wireFilePicker(inputSelector, textarea, setName) {
  const input = $(inputSelector);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    textarea.value = text;
    setName(file.name);
    syncButton();
    setStatus(`${file.name} loaded.`);
  });
}

wireFilePicker('#file-before', beforeEl, (name) => {
  beforeName = name;
});
wireFilePicker('#file-after', afterEl, (name) => {
  afterName = name;
});

/* ---------------- compare ---------------- */

compareBtn.addEventListener('click', async () => {
  compareBtn.disabled = true;
  setStatus('Comparing…');
  try {
    const response = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        before: beforeEl.value,
        after: afterEl.value,
        beforeName,
        afterName,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Comparison failed.');
    render(data);
    setStatus('');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    syncButton();
  }
});

/* ---------------- rendering ---------------- */

function stat(value, label) {
  return `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
}

function formatSegments(segments) {
  let left = '';
  let right = '';
  for (const segment of segments) {
    if (segment.op === 'eq') {
      const text = esc(segment.text);
      left += text;
      right += text;
    } else if (segment.op === 'del') {
      left += `<mark class="del">${esc(segment.text)}</mark>`;
    } else {
      right += `<mark class="ins">${esc(segment.text)}</mark>`;
    }
  }
  return { left: left.trim() || '—', right: right.trim() || '—' };
}

function renderCard(finding) {
  const sides = formatSegments(finding.segments ?? []);
  const ids = [...(finding.beforeIds ?? []), ...(finding.afterIds ?? [])].join(', ');
  return `
    <article class="card mat-${esc(finding.materiality)}">
      <div class="card-head">
        <span class="badge type-${esc(finding.type)}">${esc(finding.type)}</span>
        <span class="badge">${esc(finding.category)}</span>
        <span class="badge mat-${esc(finding.materiality)}">${esc(finding.materiality)}</span>
        <span class="section">${esc(finding.section || 'Document body')}</span>
      </div>
      <p class="rationale">${esc(finding.rationale)}</p>
      <div class="diffgrid">
        <p class="diffcell"><span class="side-label">Before</span>${sides.left}</p>
        <p class="diffcell"><span class="side-label">After</span>${sides.right}</p>
      </div>
      <p class="meta">blocks: ${esc(ids || 'n/a')} &middot; classified by: ${esc(finding.source)}</p>
    </article>
  `;
}

function render(data) {
  const findings = data.findings ?? [];
  const counts = {
    high: findings.filter((f) => f.materiality === 'high').length,
    medium: findings.filter((f) => f.materiality === 'medium').length,
  };

  statsEl.innerHTML = [
    stat(findings.length, 'changes'),
    stat(data.stats.modified, 'modified'),
    stat(data.stats.added, 'added'),
    stat(data.stats.removed, 'removed'),
    stat(counts.high, 'high'),
    stat(counts.medium, 'medium'),
  ].join('');

  cardsEl.innerHTML =
    findings.length === 0
      ? '<div class="empty">The two documents match at block level. Nothing to review.</div>'
      : findings.map(renderCard).join('');

  lastMemo = data.memo ?? '';
  memoEl.textContent = lastMemo;

  switchTab('changes');
  resultsEl.hidden = false;
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- tabs and download ---------------- */

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $('#tab-changes').hidden = name !== 'changes';
  $('#tab-memo').hidden = name !== 'memo';
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

downloadBtn.addEventListener('click', () => {
  if (!lastMemo) return;
  const blob = new Blob([lastMemo], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'change-review-memo.md';
  link.click();
  URL.revokeObjectURL(url);
});

syncButton();
