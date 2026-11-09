// ─── Error-copy rules (docs/ERROR-STANDARDS.md, the [auto] ones) ───
// Pure: given one message, return the rules it breaks. Template placeholders (${…}) are
// treated as an opaque word. Used by tests/unit/error-standards.test.ts (every inventory row) and the L1 review.

export interface CopyIssue { rule: string; detail: string }

/** Component words a person should not have to know (rule 1). Matched as whole words. */
export const JARGON = ['RPC', 'gRPC', 'PDA', 'WFP', 'lease', 'escrow', 'mandate', 'lamports', 'daemon', 'dvpnd', 'IDL', 'stack', 'nil', 'undefined', 'null', 'NaN'];
/** Forbidden synonyms (rule 10, glossary) for UI copy. */
export const SYNONYMS: Record<string, string> = { allowance: 'spending limit', 'owner account': 'wallet', withdraw: 'refund' };

const RAW = [
  /\[object Object\]/, /\bError:\s/, /\bat\s+\S+\s+\(.*:\d+:\d+\)/, // stack line
  /\b(Program error|InstructionDidNotDeserialize|Constraint[A-Z]\w+)\b/, /\bcode = [A-Z][a-zA-Z]+\b/, /\b0x[0-9a-f]{2,}\b/i,
];

export function checkCopy(raw: string, opts: { surface?: 'ui' | 'cli'; limit?: number } = {}): CopyIssue[] {
  const t = raw.replace(/\$\{[^}]*\}/g, 'X').trim();
  const out: CopyIssue[] = [];
  const limit = opts.limit ?? 300;
  if (!t) return [{ rule: 'empty', detail: 'empty message' }];
  if (t.length > limit) out.push({ rule: '7-length', detail: `${t.length} > ${limit} chars` });
  if (!/^[A-Z0-9"“(X]/.test(t)) out.push({ rule: '9-capital', detail: `starts with "${t[0]}"` });
  if (!/[.?)"”]$/.test(t) && !/X$/.test(t)) out.push({ rule: '9-full-stop', detail: 'does not end with a full stop' });
  if (/!/.test(t.replace(/!=/g, ''))) out.push({ rule: '6-exclamation', detail: 'exclamation mark' });
  if (/\bsorry\b/i.test(t)) out.push({ rule: '6-sorry', detail: '"sorry"' });
  if (/\bplease\b/i.test(t) && !/\bwait\b/i.test(t)) out.push({ rule: '6-please', detail: '"please" without asking to wait' });
  if (/^invalid\b[^.]*\.?$/i.test(t)) out.push({ rule: '6-verdict', detail: 'bare "invalid" verdict without what is needed' });
  if (/something went wrong/i.test(t) && !/(retry|try again|diagnostics|log|report)/i.test(t)) out.push({ rule: '8-catch-all', detail: '"Something went wrong" with no next step' });
  for (const re of RAW) if (re.test(t)) out.push({ rule: '5-raw', detail: `raw internals ${re}` });
  if (opts.surface !== 'cli') {
    for (const w of JARGON) if (new RegExp(`(^|[^\\w-])${w}([^\\w-]|$)`).test(t)) out.push({ rule: '1-jargon', detail: `"${w}"` });
    for (const [w, use] of Object.entries(SYNONYMS)) if (new RegExp(`\\b${w}\\b`, 'i').test(t)) out.push({ rule: '10-glossary', detail: `"${w}" → "${use}"` });
  }
  return out;
}
