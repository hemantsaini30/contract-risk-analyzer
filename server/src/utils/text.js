export const STOPWORDS = new Set(
  ('a an and are as at be been by for from has have in is it its of on or that the their this to was were will with ' +
    'shall may must any all each other such which who whom than then there these those into upon under over not no nor ' +
    'party parties agreement herein hereof thereof hereby including without').split(' ')
);

/** Light stemmer, good enough for keyword matching */
export function stem(w) {
  if (w.length > 5) w = w.replace(/(ations|ation|ings|ing|ed|es|s)$/, '');
  else if (w.length > 4) w = w.replace(/(ed|es|s)$/, '');
  return w;
}

export function tokenize(text, { keepStop = false } = {}) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => keepStop || (!STOPWORDS.has(t) && t.length > 1))
    .map(stem);
}

/** 1:1 character replacement so that offsets stay valid */
export function foldChars(s) {
  return s
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u00A0/g, ' ');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Find `quote` inside `text`, ignoring case, whitespace differences and curly quotes.
 * Returns [start, end] offsets in `text`, or null if the quote does not exist.
 * This is the core of the "no hallucinated evidence" check.
 */
export function locateQuote(text, quote) {
  if (!quote || !text) return null;
  const trim = (x) => x.replace(/^[\s"'`]+|[\s"'`]+$/g, '');
  // A quote may skip words with "..." (e.g. "must not ... announce the relationship").
  // That is accepted ONLY if every fragment exists verbatim and the fragments appear in the same order.
  const parts = trim(foldChars(quote)).split(/\s*(?:\.\.\.|\u2026)\s*/).map(trim).filter(Boolean);
  if (!parts.length) return null;
  const wc = (x) => x.split(/\s+/).length;
  if (parts.join(' ').split(/\s+/).length < 3) return null;
  if (parts.length > 1 && (parts.some((x) => wc(x) < 2) || Math.max(...parts.map(wc)) < 3)) return null;

  const haystack = foldChars(text);
  let pos = 0;
  let first = null;
  let last = 0;
  for (const part of parts) {
    const re = new RegExp(part.split(/\s+/).map(escapeRe).join('\\s+'), 'i');
    const m = re.exec(haystack.slice(pos));
    if (!m) return null;
    const start = pos + m.index;
    if (first === null) first = start;
    last = start + m[0].length;
    pos = last;
  }
  return [first, last];
}

export function splitSentences(text) {
  const out = [];
  const re = /[^.;]+(?:[.;]+|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const s = m[0];
    if (s.trim()) out.push({ text: s.trim(), start: m.index + (s.length - s.trimStart().length) });
  }
  return out;
}

export function pLimitMap(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  return Promise.all(workers).then(() => results);
}