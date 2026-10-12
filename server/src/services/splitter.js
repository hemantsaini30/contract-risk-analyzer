/**
 * Clause-aware splitting: cut at clause numbers ("1.", "2.1", "Section 3"),
 * NOT at fixed token sizes, so one clause = one legal idea = one retrieval query.
 */
const CLAUSE_START = /^\s*(?:(?:section|article|clause)\s+(\d+(?:\.\d+)*)[.:)]?|(\d+(?:\.\d+)+|\d+[.)]))\s+(?=\S)/i;
const MIN_LEN = 50;

function extractHeading(body) {
  const m = body.match(/^([A-Z][A-Za-z,&/\- ]{2,60})\.\s+(?=[A-Z"(])/);
  if (m && m[1].trim().split(/\s+/).length <= 7) return m[1].trim();
  return null;
}

export function splitClauses(text) {
  const lines = text.split('\n');
  const raw = [];
  let cur = null;
  let offset = 0;

  for (const line of lines) {
    const m = line.match(CLAUSE_START);
    if (m) {
      if (cur) raw.push(cur);
      const number = (m[1] || m[2]).replace(/[.)]$/, '');
      const lead = m[0].length;
      cur = { number, text: line.slice(lead).trim(), start: offset + lead };
    } else if (cur && line.trim()) {
      cur.text += ' ' + line.trim();
    }
    offset += line.length + 1;
  }
  if (cur) raw.push(cur);

  // merge heading-only clauses ("3. Term") into the clause that follows them
  const merged = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c.text.length < MIN_LEN && raw[i + 1]) {
      raw[i + 1] = { ...raw[i + 1], text: `${c.text}. ${raw[i + 1].text}`, number: c.number, start: c.start };
      continue;
    }
    merged.push(c);
  }

  return merged
    .filter((c) => c.text.length >= MIN_LEN)
    .map((c, idx) => ({
      idx,
      number: c.number,
      heading: extractHeading(c.text),
      text: c.text,
      start_char: c.start,
      end_char: c.start + c.text.length,
    }));
}

/** Policy documents: each rule starts with an ID like "POL-NDA-004". */
export function splitPolicies(text) {
  const re = /^\s*(POL-[A-Z]+-\d+)\b[:.\s-]*/;
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (m) {
      if (cur) out.push(cur);
      cur = { policy_id: m[1], body: line.slice(m[0].length).trim() };
    } else if (cur && line.trim()) {
      cur.body += ' ' + line.trim();
    }
  }
  if (cur) out.push(cur);
  return out.map((p) => {
    const dot = p.body.search(/[.:]\s/);
    const title = dot > 0 && dot < 80 ? p.body.slice(0, dot) : p.body.slice(0, 60);
    const body = dot > 0 && dot < 80 ? p.body.slice(dot + 1).trim() : p.body;
    return { policy_id: p.policy_id, title: title.trim(), text: body || p.body };
  });
}
