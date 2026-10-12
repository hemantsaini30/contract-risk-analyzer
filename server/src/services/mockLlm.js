import { splitSentences } from '../utils/text.js';

/**
 * MOCK "LLM": a rule engine that reads the machine-readable `mock_rule` stored with each policy.
 * It lets you test the full pipeline (retrieval -> structured output -> verification -> UI)
 * without an API key. It is NOT an AI. A real LLM ignores mock_rule and reasons from the policy text.
 */
const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  'twenty-four': 24, thirty: 30, 'thirty-six': 36, forty: 40, 'forty-five': 45, sixty: 60, ninety: 90,
};
const UNIT_DAYS = { day: 1, week: 7, month: 30, year: 365 };
const UNIT_RE = '(years?|months?|weeks?|days?)';
const WORD_RE = Object.keys(WORD_NUM).sort((a, b) => b.length - a.length).join('|');

function durationsIn(sentence) {
  const found = [];
  const add = (m, n, unit) => found.push({ phrase: m[0], days: n * UNIT_DAYS[unit.toLowerCase().replace(/s$/, '')] });
  let m;
  const a = new RegExp(`\\((\\d+)\\)\\s*${UNIT_RE}`, 'gi');
  while ((m = a.exec(sentence))) add(m, Number(m[1]), m[2]);
  const b = new RegExp(`\\b(\\d+)\\s*${UNIT_RE}`, 'gi');
  while ((m = b.exec(sentence))) add(m, Number(m[1]), m[2]);
  const c = new RegExp(`\\b(${WORD_RE})\\s+${UNIT_RE}`, 'gi');
  while ((m = c.exec(sentence))) add(m, WORD_NUM[m[1].toLowerCase()], m[2]);
  return found;
}

const firstSentence = (t) => (t.match(/^[^.]+\./) || [t.slice(0, 120)])[0].trim();

function quoteAround(sentence, matchText) {
  const words = sentence.split(/\s+/);
  if (words.length <= 40) return sentence.replace(/[.;]+$/, '');
  const idx = sentence.indexOf(matchText);
  const before = sentence.slice(0, Math.max(idx, 0)).split(/\s+/).filter(Boolean);
  const start = Math.max(before.length - 12, 0);
  return words.slice(start, start + 30).join(' ').replace(/[.;,]+$/, '');
}

function evaluateRule(clauseText, policy) {
  const rule = policy.mock_rule;
  if (!rule) return null;
  const sentences = splitSentences(clauseText);
  const topicRe = rule.topic ? new RegExp(rule.topic, 'i') : null;

  if (rule.type === 'max_duration' || rule.type === 'min_duration') {
    for (const s of sentences) {
      if (topicRe && !topicRe.test(s.text)) continue;
      for (const d of durationsIn(s.text)) {
        const bad = rule.type === 'max_duration' ? d.days > rule.days : d.days < rule.days;
        if (bad) {
          const quote = quoteAround(s.text, d.phrase);
          return {
            quote,
            reasoning: `The clause sets "${d.phrase}", which ${rule.type === 'max_duration' ? 'exceeds the maximum' : 'is below the minimum'} allowed by ${policy.policy_id}.`,
            revision: clauseText.replace(d.phrase, rule.fix_phrase),
            confidence: 0.9,
          };
        }
      }
    }
    return null;
  }

  if (rule.type === 'forbidden') {
    if (rule.unless && new RegExp(rule.unless, 'i').test(clauseText)) return null;
    const re = new RegExp(rule.pattern, 'i');
    for (const s of sentences) {
      if (s.text.split(/\s+/).length < 6) continue; // skip headings like "Residual Knowledge."
      const m = re.exec(s.text);
      if (m) {
        return {
          quote: quoteAround(s.text, m[0]),
          reasoning: `${rule.message} (${policy.policy_id}).`,
          revision: `Delete or replace the problematic wording. Suggested language: ${rule.fix}`,
          confidence: 0.9,
        };
      }
    }
    return null;
  }

  if (rule.type === 'required_if') {
    const reqRe = new RegExp(rule.required, 'i');
    for (const s of sentences) {
      if (s.text.split(/\s+/).length < 6) continue;
      if (topicRe.test(s.text) && !reqRe.test(clauseText)) {
        return {
          quote: quoteAround(s.text, s.text),
          reasoning: `${rule.message} (${policy.policy_id}).`,
          revision: `${clauseText} ${rule.fix}`,
          confidence: 0.85,
        };
      }
    }
    return null;
  }
  return null;
}

export function mockAnalyze(clause, policies) {
  const findings = [];
  for (const p of policies) {
    const r = evaluateRule(clause.text, p);
    if (!r) continue;
    findings.push({
      policy_id: p.policy_id,
      severity: p.default_severity || 'Medium',
      contract_quote: r.quote,
      policy_quote: firstSentence(p.text),
      reasoning: r.reasoning,
      suggested_revision: r.revision,
      confidence: r.confidence,
    });
  }
  return { findings };
}
