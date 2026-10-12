const esc = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COLORS = { Critical: '#b91c1c', High: '#ea580c', Medium: '#ca8a04', Low: '#2563eb' };

function highlight(text, start, end) {
  if (start == null) return esc(text);
  return `${esc(text.slice(0, start))}<mark>${esc(text.slice(start, end))}</mark>${esc(text.slice(end))}`;
}

export function buildReportHtml(contract, clauses, findings, policies) {
  const accepted = findings.filter((f) => f.review_status !== 'rejected');
  const counts = ['Critical', 'High', 'Medium', 'Low'].map((s) => `${s}: ${accepted.filter((f) => f.severity === s).length}`).join(' &nbsp;|&nbsp; ');
  const cards = accepted
    .sort((a, b) => ['Critical', 'High', 'Medium', 'Low'].indexOf(a.severity) - ['Critical', 'High', 'Medium', 'Low'].indexOf(b.severity))
    .map((f) => {
      const clause = clauses.find((c) => c.id === f.clause_id);
      const pol = policies.find((p) => p.policy_id === f.policy_id);
      const revision = f.edited_revision || f.suggested_revision;
      return `<section class="card">
  <h3><span class="badge" style="background:${COLORS[f.severity]}">${f.severity}</span> Clause ${esc(clause?.number)} ${esc(clause?.heading || '')} &rarr; ${esc(f.policy_id)}</h3>
  <p class="meta">Review status: ${esc(f.review_status)} · Evidence verified: ${f.verified ? 'yes' : 'NO'} · Confidence ${(f.confidence * 100).toFixed(0)}%</p>
  <h4>Contract clause (chars ${clause?.start_char}-${clause?.end_char})</h4><p>${highlight(clause?.text || '', f.contract_quote_start, f.contract_quote_end)}</p>
  <h4>Company policy: ${esc(pol?.title)}</h4><p>${highlight(pol?.text || '', f.policy_quote_start, f.policy_quote_end)}</p>
  <h4>Why it is a risk</h4><p>${esc(f.reasoning)}</p>
  <h4>Suggested revision${f.edited_revision ? ' (edited by reviewer)' : ''}</h4><p class="rev">${esc(revision)}</p>
  ${f.reviewer_note ? `<p><em>Reviewer note: ${esc(f.reviewer_note)}</em></p>` : ''}
</section>`;
    })
    .join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Risk report - ${esc(contract.filename)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#111}
.card{border:1px solid #ddd;border-radius:8px;padding:1rem 1.2rem;margin:1rem 0;page-break-inside:avoid}
.badge{color:#fff;border-radius:4px;padding:2px 8px;font-size:.8rem}mark{background:#fde68a}.meta{color:#666;font-size:.85rem}
h4{margin:.8rem 0 .2rem;font-size:.9rem;color:#444}.rev{background:#ecfdf5;padding:.6rem;border-radius:6px}</style></head><body>
<h1>Contract risk report</h1>
<p><b>File:</b> ${esc(contract.filename)}<br><b>Generated:</b> ${new Date().toISOString()}<br><b>Models:</b> LLM=${esc(contract.llm_provider)}, embeddings=${esc(contract.embed_provider)}</p>
<p><b>Findings (excluding rejected):</b> ${counts}</p>
<p class="meta">AI-assisted draft. Every finding must be confirmed by a human reviewer before use.</p>
${cards || '<p>No findings.</p>'}
</body></html>`;
}
