import { locateQuote } from '../utils/text.js';
import { config } from '../config.js';

/**
 * Evidence verification: every quote must exist in its source text.
 * Returns the finding enriched with offsets + verified/needs_review flags.
 * Findings that cite a policy we never retrieved are dropped (returns null).
 */
export function verifyFinding(finding, clauseText, retrievedPolicies) {
  const policy = retrievedPolicies.find((p) => p.policy_id === finding.policy_id);
  if (!policy) return null; // hallucinated / non-retrieved policy

  const c = locateQuote(clauseText, finding.contract_quote);
  const p = locateQuote(policy.text, finding.policy_quote);
  const verified = Boolean(c && p);
  const lowConfidence = finding.confidence < config.minConfidence;

  return {
    ...finding,
    // Severity is a company decision, stored with each policy. The LLM only decides WHETHER a clause conflicts.
    // (Policies without a stored severity, e.g. uploaded ones, keep the LLM's own estimate.)
    severity: policy.default_severity || finding.severity,
    llm_severity: finding.severity,
    contract_quote_start: c?.[0] ?? null,
    contract_quote_end: c?.[1] ?? null,
    policy_quote_start: p?.[0] ?? null,
    policy_quote_end: p?.[1] ?? null,
    verified,
    needs_review: !verified || lowConfidence,
    confidence: verified ? finding.confidence : Math.min(finding.confidence, 0.4),
  };
}