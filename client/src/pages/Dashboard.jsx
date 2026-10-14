import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

export default function Dashboard() {
  const [health, setHealth] = useState(null);
  const [contracts, setContracts] = useState([]);
  const [samples, setSamples] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ctype, setCtype] = useState('auto');
  const fileRef = useRef();
  const navigate = useNavigate();

  const load = () => api.contracts().then(setContracts).catch((e) => setError(e.message));

  useEffect(() => {
    api.health().then(setHealth).catch(() => setError('Cannot reach the API. Is the server running on port 4000?'));
    api.samples().then(setSamples).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  async function start(fn) {
    setBusy(true);
    setError('');
    try {
      const { id } = await fn();
      navigate(`/contracts/${id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {health && (
        <p className="banner info">
          LLM: <b>{health.llmProvider}</b> · Embeddings: <b>{health.embedProvider}</b> · Policies loaded: <b>{health.policies}</b>
          {health.llmProvider === 'mock' && ' · (mock mode: rule-based stand-in, no API key needed)'}
        </p>
      )}
      {health?.warning && <p className="banner warn">{health.warning}</p>}
      {error && <p className="banner error">{error}</p>}

      <section className="card">
        <h2>Analyze a contract</h2>
        <p className="muted">Upload a PDF, DOCX or TXT. Clauses must be numbered (1., 2.1, Section 3).</p>
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt" />
        <label style={{ marginRight: '.6rem' }}>Type{' '}
          <select value={ctype} onChange={(e) => setCtype(e.target.value)}>
            <option value="auto">Auto-detect</option>
            <option value="nda">NDA</option>
            <option value="supplier">Supplier / services</option>
          </select>
        </label>
        <button className="btn accept" disabled={busy} onClick={() => fileRef.current.files[0] && start(() => api.upload(fileRef.current.files[0], ctype))}>
          {busy ? 'Working…' : 'Upload & analyze'}
        </button>
        {samples.length > 0 && (
          <div className="samples">
            <span className="muted">No file? Try a sample:</span>
            {samples.map((s) => (
              <button key={s} className="btn ghost" disabled={busy} onClick={() => start(() => api.fromSample(s, ctype))}>{s}</button>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Contracts</h2>
        {contracts.length === 0 ? (
          <p className="muted">Nothing analyzed yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>File</th><th>Status</th><th>Critical</th><th>High</th><th>Medium</th><th>Low</th><th /></tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/contracts/${c.id}`}>{c.filename}</Link></td>
                  <td>{c.status === 'processing' ? `analyzing ${c.clauses_done}/${c.clauses_total}` : c.status}</td>
                  <td>{c.critical}</td><td>{c.high}</td><td>{c.medium}</td><td>{c.low}</td>
                  <td><button className="btn ghost small" onClick={() => api.remove(c.id).then(load)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}