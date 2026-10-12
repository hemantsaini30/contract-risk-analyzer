import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import SeverityBadge from '../components/SeverityBadge.jsx';

export default function Policies() {
  const [policies, setPolicies] = useState([]);
  const [msg, setMsg] = useState('');
  const fileRef = useRef();
  const load = () => api.policies().then(setPolicies).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);

  async function upload() {
    const f = fileRef.current.files[0];
    if (!f) return;
    try {
      const r = await api.uploadPolicies(f);
      setMsg(`Imported ${r.imported} rules: ${r.ids.join(', ')}`);
      load();
    } catch (e) {
      setMsg(e.message);
    }
  }

  return (
    <>
      <section className="card">
        <h2>Company policy rules ({policies.length})</h2>
        <p className="muted">
          Stored as text + embedding vectors in PostgreSQL (pgvector). To add your own, upload a PDF/DOCX/TXT where every rule starts with an ID,
          e.g. <code>POL-NDA-019 Title. Rule text…</code>
        </p>
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt" />
        <button className="btn accept" onClick={upload}>Upload policy file</button>
        {msg && <p className="banner info">{msg}</p>}
      </section>
      {policies.map((p) => (
        <article key={p.policy_id} className="card">
          <div className="card-head">
            <strong>{p.policy_id}</strong> <span>{p.title}</span>
            <span className="spacer" />
            {p.default_severity && <SeverityBadge level={p.default_severity} />}
          </div>
          <p className="muted small">{p.section}</p>
          <p>{p.text}</p>
        </article>
      ))}
    </>
  );
}
