/**
 * Scan for prompt-injection phrasing, hidden characters and personal data in text that enters the colony.
 *
 * Rewritten from the legacy `aidefence` threat detection. The point of scanning here: what a host
 * stores in memory or reads from a file can come back later as "context" in front of a model, so
 * hostile phrasing there is an injection route.
 *
 * Honest limits:
 * - This is a list of regular expressions. It catches the common phrasings and misses anything
 *   reworded, translated or encoded. A clean result is "nothing on the list matched", not "safe".
 * - A hit can be a false positive (text that talks ABOUT injection). The verdict is advice to the host.
 * - Excerpts and offsets come from untrusted text. They are data, never instructions.
 *
 * Differences from the legacy code: no clock, no random ids, no timings (same text, same result);
 * `DAN` is matched case-sensitively (the legacy flag also matched the name "Dan"); a fake `system:`
 * header must start a line; "disable your safety filter" now matches (the legacy pattern lacked the
 * space between "safety" and "filter" and never fired on it); card numbers need a valid Luhn checksum; PII findings never contain the
 * value; hidden characters (zero-width, bidi controls, Unicode tag characters) are reported.
 */

import { createHash } from 'node:crypto';
import { checkSecrets } from './gates.js';

export type ThreatSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ThreatType =
  | 'prompt_injection'
  | 'jailbreak'
  | 'instruction_override'
  | 'role_switching'
  | 'context_manipulation'
  | 'encoding_attack';

export interface Threat {
  type: ThreatType;
  severity: ThreatSeverity;
  confidence: number;
  description: string;
  /** Offset in the normalized text. */
  start: number;
  /** The matched phrase, at most 60 characters. Untrusted text. */
  excerpt: string;
}

export interface PiiFinding {
  kind: 'email' | 'credit_card' | 'secret';
  count: number;
}

export type Verdict = 'clean' | 'suspicious' | 'hostile';

export interface ScanResult {
  verdict: Verdict;
  threats: Threat[];
  pii: PiiFinding[];
  /** Short SHA-256 of the input, to refer to it without repeating it. */
  inputHash: string;
}

interface Pattern {
  regex: RegExp;
  type: ThreatType;
  severity: ThreatSeverity;
  description: string;
  confidence: number;
}

const PATTERNS: Pattern[] = [
  { regex: /ignore\s+(?:all\s+)?(?:previous\s+)?instructions/i, type: 'instruction_override', severity: 'critical', description: 'Attempt to override instructions', confidence: 0.95 },
  { regex: /forget\s+(?:everything|all|previous)/i, type: 'instruction_override', severity: 'critical', description: 'Attempt to reset context', confidence: 0.92 },
  { regex: /disregard\s+(?:all\s+)?(?:previous|prior|above)/i, type: 'instruction_override', severity: 'critical', description: 'Attempt to disregard instructions', confidence: 0.93 },
  { regex: /do\s+not\s+follow\s+(?:the\s+)?(?:previous|above|prior)/i, type: 'instruction_override', severity: 'high', description: 'Attempt to bypass earlier instructions', confidence: 0.88 },

  { regex: /you\s+are\s+now\s+(?!going|about|ready)/i, type: 'role_switching', severity: 'high', description: 'Attempt to change the assistant identity', confidence: 0.85 },
  { regex: /act\s+as\s+(?:if\s+you\s+are\s+)?a?\s*(?:different|new|another)/i, type: 'role_switching', severity: 'high', description: 'Attempt to assume a different role', confidence: 0.82 },
  { regex: /pretend\s+(?:to\s+be|you\s+are)/i, type: 'role_switching', severity: 'medium', description: 'Role-play instruction (may be legitimate)', confidence: 0.65 },

  // Case-sensitive on purpose: the legacy /i flag matched the name "Dan".
  { regex: /\bDAN\b[^\n]{0,200}?\bmode\b|\bmode\b[^\n]{0,200}?\bDAN\b/, type: 'jailbreak', severity: 'critical', description: 'DAN jailbreak', confidence: 0.98 },
  { regex: /jailbreak/i, type: 'jailbreak', severity: 'critical', description: 'Explicit jailbreak mention', confidence: 0.95 },
  { regex: /bypass\s+(?:your\s+)?(?:restrictions|limitations|rules|filters)/i, type: 'jailbreak', severity: 'critical', description: 'Attempt to bypass restrictions', confidence: 0.93 },
  { regex: /without\s+(?:any\s+)?(?:restrictions|limitations|rules)/i, type: 'jailbreak', severity: 'high', description: 'Request for unrestricted output', confidence: 0.85 },
  { regex: /disable\s+(?:your\s+)?(?:(?:safety|content)\s+)?filters?/i, type: 'jailbreak', severity: 'critical', description: 'Attempt to disable safety filters', confidence: 0.96 },
  { regex: /developer\s+mode|dev\s+mode|debug\s+mode/i, type: 'jailbreak', severity: 'high', description: 'Attempt to enable a developer mode', confidence: 0.85 },
  { regex: /enable\s+(?:hidden|secret|special)\s+(?:features|mode|commands)/i, type: 'jailbreak', severity: 'high', description: 'Attempt to enable hidden features', confidence: 0.88 },

  // A fake role header must open a line: "the file system: ext4" is ordinary prose.
  { regex: /(?:^|\n)\s*(?:system|assistant)\s*:|<\|system\|>|<system>/i, type: 'context_manipulation', severity: 'critical', description: 'Fake system or assistant message', confidence: 0.9 },
  { regex: /\[system\]|\{system\}|system\s+prompt/i, type: 'context_manipulation', severity: 'high', description: 'System prompt reference', confidence: 0.88 },
  { regex: /reveal\s+(?:your\s+)?(?:system\s+)?prompt/i, type: 'context_manipulation', severity: 'high', description: 'Attempt to extract the system prompt', confidence: 0.9 },
  { regex: /what\s+(?:is|are)\s+your\s+(?:initial\s+)?instructions/i, type: 'context_manipulation', severity: 'medium', description: 'Query for system instructions', confidence: 0.75 },
  { regex: /```(?:system|instruction|prompt)/i, type: 'context_manipulation', severity: 'high', description: 'Code-fence delimiter abuse', confidence: 0.85 },
  { regex: /---\s*(?:system|instruction|prompt)/i, type: 'context_manipulation', severity: 'medium', description: 'Markdown delimiter abuse', confidence: 0.7 },

  { regex: /base64|rot13|hex\s+encode|url\s+encode/i, type: 'encoding_attack', severity: 'medium', description: 'Possible encoding-based bypass', confidence: 0.6 },
  { regex: /decode\s+this|encrypted\s+message/i, type: 'encoding_attack', severity: 'medium', description: 'Request to decode hidden content', confidence: 0.55 },

  { regex: /hypothetically|in\s+theory|theoretically|if\s+you\s+could/i, type: 'prompt_injection', severity: 'low', description: 'Hypothetical framing (often legitimate)', confidence: 0.45 },
  { regex: /for\s+(?:educational|research|academic)\s+purposes/i, type: 'prompt_injection', severity: 'low', description: 'Educational framing (often legitimate)', confidence: 0.35 },
];

const SEVERITY_ORDER: Record<ThreatSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** NFKC, hidden characters removed, runs of spaces and tabs collapsed. Line breaks stay, so line-start rules work. */
export function normalizeForScan(input: string): string {
  return input
    .normalize('NFKC')
    // eslint-disable-next-line no-irregular-whitespace
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩᠎﻿\u{E0000}-\u{E007F}]/gu, '')
    // eslint-disable-next-line no-irregular-whitespace
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ ?\r?\n ?/g, '\n')
    .trim();
}

// The characters in this class are invisible on purpose: they are what the scan looks for.
// eslint-disable-next-line no-irregular-whitespace
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩᠎﻿]/u;
const TAGS = /[\u{E0000}-\u{E007F}]/u;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

function findPii(input: string): PiiFinding[] {
  const findings: PiiFinding[] = [];
  // Bounded quantifiers (RFC 5321 limits): the unbounded legacy form was quadratic on inputs like "a.a.a...".
  const emails = input.match(/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g) ?? [];
  if (emails.length > 0) findings.push({ kind: 'email', count: emails.length });
  const cards = (input.match(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g) ?? []).filter((c) => luhnValid(c.replace(/\D/g, '')));
  if (cards.length > 0) findings.push({ kind: 'credit_card', count: cards.length });
  const secrets = checkSecrets(input);
  if (secrets) findings.push({ kind: 'secret', count: Number(secrets.details.count) });
  return findings;
}

function confidenceOf(base: number, indicators: number, index: number, length: number): number {
  let c = base;
  if (indicators > 1) c = Math.min(c + 0.05 * (indicators - 1), 0.99);
  if (length < 50) c *= 0.9;
  if (index < 20) c = Math.min(c + 0.05, 0.99);
  return Math.round(c * 100) / 100;
}

export function scanText(input: string): ScanResult {
  const text = normalizeForScan(input);
  const hits: Array<{ pattern: Pattern; index: number; length: number; text: string }> = [];
  for (const pattern of PATTERNS) {
    const m = pattern.regex.exec(text);
    if (m) hits.push({ pattern, index: m.index, length: m[0].length, text: m[0] });
  }

  const threats: Threat[] = hits.map(({ pattern, index, text: matched }) => {
    const confidence = confidenceOf(pattern.confidence, hits.length, index, text.length);
    const severity: ThreatSeverity =
      confidence < 0.5 && pattern.severity === 'critical' ? 'high' : confidence < 0.4 && pattern.severity === 'high' ? 'medium' : pattern.severity;
    return { type: pattern.type, severity, confidence, description: pattern.description, start: index, excerpt: matched.trim().slice(0, 60) };
  });

  if (TAGS.test(input)) {
    threats.push({ type: 'encoding_attack', severity: 'high', confidence: 0.9, description: 'Unicode tag characters (invisible text smuggling)', start: 0, excerpt: '' });
  } else if (HIDDEN.test(input)) {
    threats.push({ type: 'encoding_attack', severity: 'medium', confidence: 0.6, description: 'Invisible or bidirectional control characters', start: 0, excerpt: '' });
  }

  // One threat per type: the most confident one.
  const byType = new Map<ThreatType, Threat>();
  for (const t of threats) {
    const existing = byType.get(t.type);
    if (!existing || t.confidence > existing.confidence) byType.set(t.type, t);
  }
  const kept = Array.from(byType.values()).sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.confidence - a.confidence || (a.type < b.type ? -1 : 1)
  );

  const hostile = kept.some((t) => (t.severity === 'critical' || t.severity === 'high') && t.confidence >= 0.8);
  return {
    verdict: hostile ? 'hostile' : kept.length > 0 ? 'suspicious' : 'clean',
    threats: kept,
    pii: findPii(input),
    inputHash: createHash('sha256').update(input).digest('hex').slice(0, 16),
  };
}
