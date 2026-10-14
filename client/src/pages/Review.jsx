import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import FindingCard from '../components/FindingCard.jsx';

const ORDER = ['Critical', 'High', 'Medium', 'Low'];

export default function Review() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [sev, setSev] = useState('All');
  const [onlyReview, setOnlyReview] = useState(false);
  const [hideRejected, setHideRejected] = useState(true);
  const [showClean, setShowClean] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const d = await api.contract(id);
        if (stop) return;
        setData(d);
        if (d.contract.status === 'processing') setTimeout(load, 1500);
      } catch (e) {
        setError(e.message);
      }
    };
    load();
    return () => { stop = true; };
  }, [id]);

  const policyById = useMemo(() => Object.fromEntries((data?.policies || []).map((p) => [p.policy_id, p])), [data]);
  const clauseById = useMemo(() => Object.fromEntries((data?.clauses || []).map((c) => [c.id, c])), [data]);

  if (error) return <p className="banner error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const { contract, clauses, findings } = data;
  const updateFinding = (f) => setData((d) => ({ ...d, findings: d.findings.map((x) => (x.id === f.id ? f : x)) }));

  const visible = findings
    .filter((f) => sev === 'All' || f.severity === sev)
    .filter((f) => !onlyReview || f.needs_review)
    .filter((f) => !hideRejected || f.review_status !== 'rejected')
    .sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || clauseById[a.clause_id].idx - clauseById[b.clause_id].idx);

  const flaggedClauseIds = new Set(findings.map((f) => f.clause_id));
  const cleanClauses = clauses.filter((c) => !flaggedClauseIds.has(c.id));
  const counts = Object.fromEntries(ORDER.map((s) => [s, findings.filter((f) => f.severity === s && f.review_status !== 'rejected').length]));
  const reviewed = findings.filter((f) => f.review_status !== 'pending').length;

  return (
    <>
      <p><Link to="/contracts">← All contracts</Link></p>
      <section className="card">
        <div className="card-head">
          <h2>{contract.filename}</h2>
          <span className="spacer" />
          <label className="small">Contract type{' '}
            <select value={contract.contract_type || 'auto'} onChange={(e) => api.reanalyze(id, e.target.value).then(() => window.location.reload())}>
              <option value="auto">auto / unknown</option>
              <option value="nda">NDA</option>
              <option value="supplier">Supplier / services</option>
            </select>
          </label>
          <button className="btn ghost" onClick={() => { api.reanalyze(id).then(() => window.location.reload()); }}>Re-run analysis</button>
          <a className="btn accept" href={api.reportUrl(id)}>Export report</a>
        </div>

        {contract.status === 'processing' && (
          <>
            <p>Analyzing clause {contract.clauses_done} of {contract.clauses_total}…</p>
            <progress value={contract.clauses_done} max={contract.clauses_total || 1} />
          </>
        )}
        {contract.status === 'error' && <p className="banner error">Analysis failed: {contract.error}</p>}

        <div className="summary">
          {ORDER.map((s) => (
            <div key={s} className={`stat sev-${s}`}><b>{counts[s]}</b><span>{s}</span></div>
          ))}
          <div className="stat"><b>{reviewed}/{findings.length}</b><span>reviewed</span></div>
        </div>
        <p className="muted small">LLM: {contract.llm_provider} · Embeddings: {contract.embed_provider} · AI-assisted draft: a human must confirm every finding.</p>

        <div className="filters">
          <label>Severity{' '}
            <select value={sev} onChange={(e) => setSev(e.target.value)}>
              <option>All</option>{ORDER.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label><input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} /> needs-review only</label>
          <label><input type="checkbox" checked={hideRejected} onChange={(e) => setHideRejected(e.target.checked)} /> hide rejected</label>
        </div>
      </section>

      {visible.map((f) => (
        <FindingCard key={f.id} finding={f} clause={clauseById[f.clause_id]} policy={policyById[f.policy_id]} onChange={updateFinding} />
      ))}
      {contract.status === 'done' && visible.length === 0 && <p className="muted">No findings match the filters.</p>}

      {contract.status === 'done' && (
        <section className="card">
          <button className="btn ghost" onClick={() => setShowClean((v) => !v)}>
            {showClean ? 'Hide' : 'Show'} clauses with no findings ({cleanClauses.length})
          </button>
          {showClean && cleanClauses.map((c) => (
            <div key={c.id} className="clean-clause">
              <b>Clause {c.number}{c.heading ? ` · ${c.heading}` : ''}</b>
              <p className="source">{c.text}</p>
              <p className="muted small">
                Policies checked: {(c.retrieved || []).map((r) => r.policy_id).join(', ') || 'none'}
              </p>
            </div>
          ))}
        </section>
      )}
    </>
  );
}