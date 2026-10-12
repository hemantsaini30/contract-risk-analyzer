import { useState } from 'react';
import { api } from '../api.js';
import SeverityBadge from './SeverityBadge.jsx';
import Highlight from './Highlight.jsx';

export default function FindingCard({ finding, clause, policy, onChange }) {
  const [revision, setRevision] = useState(finding.edited_revision || finding.suggested_revision);
  const [note, setNote] = useState(finding.reviewer_note || '');
  const [busy, setBusy] = useState(false);

  async function act(review_status) {
    setBusy(true);
    try {
      const patch = { review_status, reviewer_note: note || null };
      if (review_status === 'edited' || revision !== finding.suggested_revision) patch.edited_revision = revision;
      onChange(await api.review(finding.id, patch));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`card finding status-${finding.review_status}`}>
      <div className="card-head">
        <SeverityBadge level={finding.severity} />
        <strong>
          Clause {clause.number}{clause.heading ? ` · ${clause.heading}` : ''} → {finding.policy_id}
        </strong>
        <span className="spacer" />
        {finding.verified ? (
          <span className="pill ok" title="Both quotes were found verbatim in their source text">✔ evidence verified</span>
        ) : (
          <span className="pill warn" title="A quote could not be found in the source text">⚠ evidence NOT verified</span>
        )}
        {finding.needs_review && <span className="pill warn">needs careful review</span>}
        <span className="pill">{Math.round(finding.confidence * 100)}% confidence</span>
      </div>

      <div className="two-col">
        <section>
          <h4>📄 Contract clause <small>(chars {clause.start_char}–{clause.end_char})</small></h4>
          <p className="source"><Highlight text={clause.text} start={finding.contract_quote_start} end={finding.contract_quote_end} /></p>
        </section>
        <section>
          <h4>📘 Company policy · {policy?.title}</h4>
          <p className="source"><Highlight text={policy?.text} start={finding.policy_quote_start} end={finding.policy_quote_end} /></p>
        </section>
      </div>

      <h4>Why this is a risk</h4>
      <p>{finding.reasoning}</p>

      <h4>Suggested revision <small>(editable)</small></h4>
      <textarea value={revision} onChange={(e) => setRevision(e.target.value)} rows={3} />
      <input className="note" placeholder="Reviewer note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />

      <div className="actions">
        <button className="btn accept" disabled={busy} onClick={() => act('accepted')}>Accept</button>
        <button className="btn edit" disabled={busy} onClick={() => act('edited')}>Save edited revision</button>
        <button className="btn reject" disabled={busy} onClick={() => act('rejected')}>Reject (false alarm)</button>
        <span className="spacer" />
        <span className={`status-label s-${finding.review_status}`}>{finding.review_status}</span>
      </div>
    </article>
  );
}
