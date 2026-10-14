import { useEffect, useState } from 'react';
import { api } from '../api.js';
import SeverityBadge from '../components/SeverityBadge.jsx';
import Highlight from '../components/Highlight.jsx';

export default function Check() {
  const [clause, setClause] = useState('');
  const [examples, setExamples] = useState([]);
  const [known, setKnown] = useState(null); // the known right answer for a loaded example
  const [ctype, setCtype] = useState('nda'); // which family of policies to check against
  const [result, setResult] = useState(null);
  const [checkedText, setCheckedText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.examples().then(setExamples).catch(() => {}); }, []);

  function loadExample(id) {
    const ex = examples.find((e) => e.id === id);
    setResult(null); setError('');
    if (!ex) { setKnown(null); return; }
    setClause(ex.clause);
    setKnown(ex);
    setCtype(ex.contract_type || 'nda');
  }

  async function run() {
    setBusy(true); setError(''); setResult(null);
    try {
      const r = await api.check(clause, ctype === 'auto' ? null : ctype);
      setResult(r);
      setCheckedText(clause);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const policyById = Object.fromEntries((result?.policies_checked || []).map((p) => [p.policy_id, p]));
  const bad = result?.verdict === 'violation';

  // compare with the known answer (only when an example is loaded and its text is unchanged)
  const knownApplies = known && result && checkedText === known.clause;
  let match = null;
  if (knownApplies) {
    const extras = new Set(known.acceptable_extra || []);
    const want = known.expected.map((e) => e.policy_id).sort().join(',');
    const got = result.findings.map((f) => f.policy_id).filter((id) => !extras.has(id)).sort().join(',');
    match = want === got;
  }

  return (
    <>
      <section className="card">
        <h2>Check a clause against company policy</h2>
        <p className="muted">
          Paste one contract clause. The system finds the most relevant policy rules in the database, asks the LLM to judge the clause against
          only those rules, and verifies every quote it gives as evidence.
        </p>

        {examples.length > 0 && (
          <p>
            <label>Or load an example:{' '}
              <select defaultValue="" onChange={(e) => loadExample(e.target.value)}>
                <option value="">— choose —</option>
                {examples.map((e) => (
                  <option key={e.id} value={e.id}>{e.id}: {e.clause.slice(0, 70)}…</option>
                ))}
              </select>
            </label>
          </p>
        )}

        <p>
          <label>Contract type:{' '}
            <select value={ctype} onChange={(e) => setCtype(e.target.value)}>
              <option value="nda">NDA / confidentiality agreement</option>
              <option value="supplier">Supplier / services agreement</option>
              <option value="auto">Not sure (check against all policies)</option>
            </select>
          </label>
          <span className="muted small"> The clause is only compared with policies for that type.</span>
        </p>

        <textarea
          rows={5}
          value={clause}
          placeholder='e.g. "The obligations of confidentiality shall survive for a period of seven (7) years after termination."'
          onChange={(e) => { setClause(e.target.value); setKnown(null); }}
        />
        <div className="actions">
          <button className="btn accept" disabled={busy || clause.trim().length < 20} onClick={run}>
            {busy ? 'Checking…' : 'Check clause'}
          </button>
          <span className="muted small">{clause.length} characters</span>
        </div>
        {error && <p className="banner error">{error}</p>}
      </section>

      {result && (
        <>
          <section
            className="card"
            style={{ borderLeft: `6px solid ${bad ? '#dc2626' : '#16a34a'}`, background: bad ? '#fef2f2' : '#f0fdf4' }}
          >
            <h2 style={{ margin: 0 }}>
              {bad
                ? `❌ Conflicts with company policy (${result.findings.length} issue${result.findings.length > 1 ? 's' : ''})`
                : '✅ No conflict found with the retrieved policies'}
            </h2>
            <p className="muted small">
              Checked against {result.policies_checked.map((p) => p.policy_id).join(', ')} · type: {result.contract_type || 'any'} · LLM: {result.models.llm} · embeddings: {result.models.embeddings} · {(result.ms / 1000).toFixed(1)}s
            </p>
            {knownApplies && (
              <p>
                <b>Known answer for this example:</b>{' '}
                {known.expected.length
                  ? known.expected.map((e) => `${e.policy_id} (${e.severity})`).join(', ')
                  : 'compliant, no conflict'}
                {known.acceptable_extra?.length ? ` (also acceptable: ${known.acceptable_extra.join(', ')})` : ''}
                {known.note ? ` · note: ${known.note}` : ''}
                {' → '}
                <b style={{ color: match ? '#16a34a' : '#dc2626' }}>{match ? 'system is RIGHT ✔' : 'system is WRONG ✘'}</b>
              </p>
            )}
          </section>

          {result.findings.map((f, i) => {
            const pol = policyById[f.policy_id];
            return (
              <article key={i} className="card finding">
                <div className="card-head">
                  <SeverityBadge level={f.severity} />
                  <strong>{f.policy_id}{pol ? ` · ${pol.title}` : ''}</strong>
                  <span className="spacer" />
                  {f.verified
                    ? <span className="pill ok" title="Both quotes were found verbatim in their source text">✔ evidence verified</span>
                    : <span className="pill warn" title="A quote could not be found in the source text">⚠ evidence NOT verified</span>}
                  <span className="pill">{Math.round(f.confidence * 100)}% confidence</span>
                </div>
                <div className="two-col">
                  <section>
                    <h4>📄 Your clause</h4>
                    <p className="source"><Highlight text={checkedText} start={f.contract_quote_start} end={f.contract_quote_end} /></p>
                  </section>
                  <section>
                    <h4>📘 Company policy</h4>
                    <p className="source"><Highlight text={pol?.text} start={f.policy_quote_start} end={f.policy_quote_end} /></p>
                  </section>
                </div>
                <h4>Why this is a risk</h4>
                <p>{f.reasoning}</p>
                <h4>Suggested revision</h4>
                <p className="source" style={{ background: '#ecfdf5' }}>{f.suggested_revision}</p>
              </article>
            );
          })}

          <section className="card">
            <h4 style={{ marginTop: 0 }}>Policies the system retrieved and checked</h4>
            {result.policies_checked.map((p) => (
              <p key={p.policy_id} className="small">
                <b>{p.policy_id}</b> · {p.title}
                <span className="muted"> (vector similarity {p.scores.vector != null ? p.scores.vector.toFixed(2) : '–'})</span>
              </p>
            ))}
          </section>
        </>
      )}
    </>
  );
}