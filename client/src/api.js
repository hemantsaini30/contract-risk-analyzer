const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(BASE + path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const json = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export const api = {
  health: () => request('/health'),
  examples: () => request('/check/examples'),
  check: (clause, contract_type) => request('/check', json('POST', { clause, contract_type })),
  contracts: () => request('/contracts'),
  contract: (id) => request(`/contracts/${id}`),
  samples: () => request('/contracts/samples'),
  fromSample: (filename, contract_type) => request('/contracts/from-sample', json('POST', { filename, contract_type })),
  upload: (file, contract_type) => {
    const fd = new FormData();
    fd.append('contract_type', contract_type || 'auto');
    fd.append('file', file);
    return request('/contracts', { method: 'POST', body: fd });
  },
  reanalyze: (id, contract_type) => request(`/contracts/${id}/reanalyze`, contract_type ? json('POST', { contract_type }) : { method: 'POST' }),
  remove: (id) => request(`/contracts/${id}`, { method: 'DELETE' }),
  reportUrl: (id) => `${BASE}/contracts/${id}/report`,
  policies: () => request('/policies'),
  uploadPolicies: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('/policies/upload', { method: 'POST', body: fd });
  },
  review: (findingId, patch) => request(`/findings/${findingId}`, json('PATCH', patch)),
};