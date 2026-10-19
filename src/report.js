/**
 * Turn verified findings into a one-page review memo a human can act on.
 * Runs on findings only, so every sentence traces back to a real change.
 */

function cell(text, max = 90) {
  const value = String(text ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function oneLine(change) {
  if (change.type === 'added') return `New text: ${cell(change.after, 80)}`;
  if (change.type === 'removed') return `Deleted text: ${cell(change.before, 80)}`;
  return `${cell(change.before, 40)} → ${cell(change.after, 40)}`;
}

function questionsFor(findings) {
  const questions = [];
  for (const finding of findings) {
    if (finding.materiality !== 'high') continue;
    if (finding.category === 'numbers') {
      questions.push(`Confirm the new figure in "${cell(finding.section || 'this section', 60)}" is intended and approved by the document owner.`);
    } else if (finding.category === 'obligation') {
      questions.push(`Confirm the weaker or changed obligation in "${cell(finding.section || 'this section', 60)}" is intentional, and that the owning team accepts the new duty.`);
    } else if (finding.category === 'scope') {
      questions.push(`Confirm the ${finding.type === 'added' ? 'new' : 'removed'} clause in "${cell(finding.section || 'this section', 60)}" has been reviewed by the approver.`);
    }
  }
  const unique = [...new Set(questions)];
  return unique.length > 0 ? unique : ['No questions raised. All changes were classified as low materiality.'];
}

export function buildMemo({ beforeName, afterName, findings, stats, engine }) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.materiality] += 1;

  const lines = [];
  lines.push('# Change review memo');
  lines.push('');
  lines.push(`**Before:** \`${beforeName}\``);
  lines.push(`**After:** \`${afterName}\``);
  lines.push(`**Generated:** ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  lines.push(`**Classification engine:** ${engine}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  if (findings.length === 0) {
    lines.push('The two documents are identical at block level. No changes to review.');
  } else {
    lines.push(`- ${stats.total} changed region${stats.total === 1 ? '' : 's'}: ${stats.modified} modified, ${stats.added} added, ${stats.removed} removed.`);
    lines.push(`- Materiality: ${counts.high} high, ${counts.medium} medium, ${counts.low} low.`);
    const material = findings.filter((f) => f.materiality !== 'low');
    lines.push(
      material.length === 0
        ? '- No change affects an obligation, a figure, or the scope of the document.'
        : `- ${material.length} change${material.length === 1 ? '' : 's'} need a human decision.`,
    );
  }
  lines.push('');

  lines.push('## Changes');
  lines.push('');
  if (findings.length === 0) {
    lines.push('_Nothing to list._');
  } else {
    lines.push('| # | Section | Type | Category | Materiality | Change |');
    lines.push('|---|---------|------|----------|-------------|--------|');
    findings.forEach((finding, index) => {
      lines.push(
        `| ${index + 1} | ${cell(finding.section || '—', 40)} | ${finding.type} | ${finding.category} | ${finding.materiality} | ${oneLine(finding)} |`,
      );
    });
  }
  lines.push('');

  const detailed = findings.filter((f) => f.materiality !== 'low');
  if (detailed.length > 0) {
    lines.push('## Detail');
    lines.push('');
    detailed.forEach((finding, index) => {
      lines.push(`### ${index + 1}. ${cell(finding.section || 'Untitled section', 70)} (${finding.materiality})`);
      lines.push('');
      lines.push(`- **Why it matters:** ${finding.rationale}`);
      for (const [label, value] of [
        ['Before', finding.before],
        ['After', finding.after],
      ]) {
        if (!value) continue;
        if (value.includes('\n')) {
          lines.push(`- **${label}:**`);
          lines.push('');
          lines.push('```');
          lines.push(value);
          lines.push('```');
          lines.push('');
        } else {
          lines.push(`- **${label}:** ${cell(value, 300)}`);
        }
      }
      lines.push(`- **Location:** ${[...finding.beforeIds, ...finding.afterIds].join(', ') || 'n/a'}`);
      lines.push('');
    });
  }

  lines.push('## Reviewer questions');
  lines.push('');
  for (const question of questionsFor(findings)) lines.push(`- ${question}`);
  lines.push('');

  return lines.join('\n');
}
