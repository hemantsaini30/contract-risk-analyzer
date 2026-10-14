/** Which family of policies applies? Detected from the title / opening lines; the user can override it. */
export const CONTRACT_TYPES = ['nda', 'supplier'];

export function normalizeType(t) {
  const v = String(t || '').toLowerCase();
  return CONTRACT_TYPES.includes(v) ? v : null; // anything else (auto, unknown, empty) = no filter
}

export function detectContractType(text) {
  const head = text.slice(0, 700).toLowerCase();
  if (/non-?disclosure|confidentiality agreement|\bnda\b|mutual confidentiality|confidential information agreement/.test(head)) return 'nda';
  if (/services agreement|master services|supply agreement|supplier|software licen[cs]e|saas|subscription agreement|consulting agreement|statement of work|reseller agreement|hosting|licen[cs]e agreement|procurement/.test(head)) return 'supplier';
  return null;
}