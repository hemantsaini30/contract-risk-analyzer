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
  const cleanQuote = foldChars(quote)
    .replace(/(\.\.\.|\u2026)/g, ' ')
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '');
  const words = cleanQuote.split(/\s+/).filter(Boolean);
  if (words.length < 3) return null;
  const re = new RegExp(words.map(escapeRe).join('\\s+'), 'i');
  const m = re.exec(foldChars(text));
  return m ? [m.index, m.index + m[0].length] : null;
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
