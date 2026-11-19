/** A regular expression in JavaScript form (see re2.ts for how a Go one gets here). */
export interface RulePattern {
  source: string;
  flags: string;
}

/**
 * Something that says "this finding is not a secret". The parts of an allowlist that need a file name or a commit
 * (paths, commits) are dropped on conversion: the colony scans text, and dropping them only ever means more findings.
 */
export interface RuleAllowlist {
  regexes: RulePattern[];
  stopwords: string[];
  /** What the regexes are matched against: the whole match, the line it is on, or the secret itself. */
  target: 'match' | 'line' | 'secret';
  /** OR: any of the regexes or stopwords allows it. AND: a regex and a stopword must both apply. */
  condition: 'OR' | 'AND';
}

export interface RuleEntry {
  id: string;
  description: string;
  pattern: RulePattern;
  /** Lower case. The rule runs only when the text contains one of them (when there are any). */
  keywords: string[];
  /** Shannon entropy (bits per character) the secret must reach, or null. */
  entropy: number | null;
  /** Which capture group is the secret: this one, else the first group when the pattern has one, else the match. */
  secretGroup: number | null;
  allowlists: RuleAllowlist[];
}

export interface RulesetFile {
  format: 1;
  name: string;
  version: string;
  rules: RuleEntry[];
  globalAllowlist: RuleAllowlist | null;
}

/** The kinds of personal data the PII rule sets find (names as in redact.ts, plus mac_address). */
export type PiiEntity = 'ip_address' | 'iban' | 'credit_card' | 'mac_address';

export interface PiiRule {
  id: string;
  entity: PiiEntity;
  pattern: RulePattern;
  /** The upstream's own score for the pattern alone (0 to 1); absent when the file that holds it is not vendored. */
  score?: number;
}

/** A converted personal data rule set. It carries patterns only: the checks (checksums, address validity) are the colony's own. */
export interface PiiRulesetFile {
  format: 1;
  kind: 'pii';
  name: string;
  version: string;
  rules: PiiRule[];
}

export interface SkippedRule {
  id: string;
  reason: string;
}

/** What was not carried over, so that nobody has to take "222 rules" on trust. */
export interface ConversionReport {
  total: number;
  converted: number;
  skipped: SkippedRule[];
  /** Counts of things dropped on purpose without skipping the rule (paths, commits, allowlist regexes that did not convert). */
  dropped: Record<string, number>;
}

export interface SecretFinding {
  ruleset: string;
  rule: string;
  /** The secret itself, as a position in the text: the value is never copied out. */
  offset: number;
  length: number;
}
