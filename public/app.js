/** Front-end glue: load two documents, post them, render the review. */

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
const noticeEl = $('#notice');
const filteredNoteEl = $('#filtered-note');

const beforeFileEl = $('#before-file');
const afterFileEl = $('#after-file');

let beforeName = 'before.md';
let afterName = 'after.md';
let lastMemo = '';
let lastFindings = [];
let activeFilter = 'all';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function showNotice(message, tone = 'warn') {
  if (!message) {
    noticeEl.hidden = true;
    noticeEl.textContent = '';
    return;
  }
  noticeEl.hidden = false;
  noticeEl.textContent = message;
  noticeEl.dataset.tone = tone;
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
        beforeName = `policy-${version}.md`;
        beforeFileEl.textContent = beforeName;
      } else {
        afterEl.value = text;
        afterName = `policy-${version}.md`;
        afterFileEl.textContent = afterName;
      }
      showNotice('');
      syncButton();
      setStatus('');
    } catch (error) {
      setStatus(error.message, true);
    }
  });
});

/**
 * Upload a file, ask the server to extract its text, then drop that text into
 * the pane. Extraction is lossy, so any warning is surfaced rather than hidden.
 */
async function loadFile(file, side) {
  const textarea = side === 'before' ? beforeEl : afterEl;
  const label = side === 'before' ? beforeFileEl : afterFileEl;

  setStatus(`Reading ${file.name}…`);
  showNotice('');
  compareBtn.disabled = true;

  try {
    const response = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(file.name) },
      body: file,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Could not read ${file.name}.`);

    textarea.value = data.text;
    if (side === 'before') beforeName = file.name;
    else afterName = file.name;
    label.textContent = file.name;

    const chars = data.text.length;
    const pages = data.info?.pages ? `, ${data.info.pages} page${data.info.pages === 1 ? '' : 's'}` : '';
    setStatus(`${file.name}: ${chars.toLocaleString()} characters read${pages}.`);

    if (data.info?.warning) showNotice(data.info.warning, 'warn');
    else if (chars < 300) showNotice('Very little text was found in that file. Check the preview below before comparing.', 'warn');
  } catch (error) {
    setStatus(error.message, true);
    showNotice(error.message, 'error');
  } finally {
    syncButton();
  }
}

function wireFilePicker(inputSelector, side) {
  const input = $(inputSelector);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    await loadFile(file, side);
    input.value = '';
  });
}

wireFilePicker('#file-before', 'before');
wireFilePicker('#file-after', 'after');

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

function matchesFilter(finding) {
  if (activeFilter === 'high') return finding.materiality === 'high';
  if (activeFilter === 'material') return finding.materiality !== 'low';
  return true;
}

function renderCards() {
  const visible = lastFindings.filter(matchesFilter);

  if (lastFindings.length === 0) {
    cardsEl.innerHTML = '<div class="empty">The two documents match at block level. Nothing to review.</div>';
    filteredNoteEl.hidden = true;
    return;
  }

  if (visible.length === 0) {
    cardsEl.innerHTML = '<div class="empty">No changes at this materiality level.</div>';
  } else {
    cardsEl.innerHTML = visible.map(renderCard).join('');
  }

  const hidden = lastFindings.length - visible.length;
  filteredNoteEl.hidden = hidden === 0;
  filteredNoteEl.textContent =
    hidden === 0 ? '' : `${hidden} change${hidden === 1 ? '' : 's'} hidden by the current filter.`;
}

function updateFilterCounts() {
  const counts = {
    all: lastFindings.length,
    material: lastFindings.filter((f) => f.materiality !== 'low').length,
    high: lastFindings.filter((f) => f.materiality === 'high').length,
  };
  document.querySelectorAll('#filters .chip').forEach((chip) => {
    const key = chip.dataset.filter;
    const label = { all: 'All', material: 'High + medium', high: 'High only' }[key];
    chip.textContent = `${label} (${counts[key]})`;
  });
}

document.querySelectorAll('#filters .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    activeFilter = chip.dataset.filter;
    document.querySelectorAll('#filters .chip').forEach((other) => {
      other.classList.toggle('active', other === chip);
    });
    renderCards();
  });
});

function render(data) {
  lastFindings = data.findings ?? [];
  activeFilter = 'all';
  document.querySelectorAll('#filters .chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.filter === 'all');
  });

  const counts = {
    high: lastFindings.filter((f) => f.materiality === 'high').length,
    medium: lastFindings.filter((f) => f.materiality === 'medium').length,
  };

  statsEl.innerHTML = [
    stat(lastFindings.length, 'changes'),
    stat(data.stats.modified, 'modified'),
    stat(data.stats.added, 'added'),
    stat(data.stats.removed, 'removed'),
    stat(counts.high, 'high'),
    stat(counts.medium, 'medium'),
  ].join('');

  updateFilterCounts();
  renderCards();

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
