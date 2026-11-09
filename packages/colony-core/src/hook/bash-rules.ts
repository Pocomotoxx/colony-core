/**
 * Pattern rules for shell commands the hook guard inspects, beyond the generic destructive gate.
 *
 * Honest limit, stated in the README too: these are TEXT patterns over the one command string the
 * host shows the hook. They catch the common ways a command writes where it should not or destroys
 * work (redirection, tee, sed -i, find -delete, git checkout/restore, pipe to a shell, recursive
 * chmod, interpreter one-liners). They are not a sandbox: a script file, an alias, or a command
 * assembled at run time is invisible here. Containment, not proof.
 */

export interface BashFinding {
  decision: 'ask' | 'deny';
  reason: string;
}

/** Paths only colony commands may change. A shell command that writes into them is refused. */
const PROTECTED = String.raw`\.?(?:colony|git)[/\\]`;

interface Rule {
  name: string;
  pattern: RegExp;
  decision: 'ask' | 'deny';
  reason: string;
}

const RULES: Rule[] = [
  {
    name: 'write into protected path',
    // redirection (>, >>), tee, cp/mv targets, sed -i, or any mention of the path right after a writing tool
    pattern: new RegExp(String.raw`(?:>>?\s*|\btee\s+(?:-a\s+)?|\bsed\s+[^|;&]*-i[^|;&]*\s|\b(?:cp|mv|install)\s+[^|;&]*\s)['"]?${PROTECTED}`, 'i'),
    decision: 'deny',
    reason: "the command writes into .colony/ or .git/; the colony's state and rule files change only through colony commands",
  },
  {
    name: 'delete or truncate protected path',
    pattern: new RegExp(String.raw`\b(?:rm|del|rmdir|unlink|truncate)\b[^|;&]*${PROTECTED}`, 'i'),
    decision: 'deny',
    reason: 'the command deletes inside .colony/ or .git/',
  },
  {
    name: 'find -delete / -exec rm',
    pattern: /\bfind\b[^|;&]*(?:-delete\b|-exec\s+rm\b)/i,
    decision: 'ask',
    reason: 'find with -delete or -exec rm removes files in bulk',
  },
  {
    name: 'git discards working-tree changes',
    pattern: /\bgit\s+(?:checkout\s+(?:--|\.)|restore\s)/i,
    decision: 'ask',
    reason: 'git checkout --/git restore discards uncommitted work',
  },
  {
    name: 'download piped into a shell',
    pattern: /\b(?:curl|wget|iwr|invoke-webrequest)\b[^|;&]*\|\s*(?:ba|z|da|k)?sh\b|\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:node|python[0-9.]*|perl|ruby|pwsh|powershell)\b/i,
    decision: 'ask',
    reason: 'the command downloads code and runs it in one step',
  },
  {
    name: 'PowerShell recursive force delete',
    pattern: /\b(?:remove-item|ri|del)\b[^|;&]*-(?:recurse|force)\b[^|;&]*-(?:recurse|force)\b/i,
    decision: 'ask',
    reason: 'Remove-Item -Recurse -Force deletes a tree without confirmation',
  },
  {
    name: 'recursive permission change',
    pattern: /\b(?:chmod|chown|icacls)\b[^|;&]*(?:-R\b|\/t\b)/i,
    decision: 'ask',
    reason: 'a recursive permission change is hard to undo',
  },
  {
    name: 'interpreter one-liner that touches the filesystem',
    // node -e / python -c / perl -e / ruby -e whose code mentions writing or deleting
    pattern: /\b(?:node|python[0-9.]*|perl|ruby)\b[^|;&]*\s-(?:e|c)\b[^|;&]*(?:writeFile|rmSync|rm\(|unlink|rmdir|rmtree|remove\(|open\([^)]*['"]w|shutil|truncate)/i,
    decision: 'ask',
    reason: 'an inline script writes or deletes files; the guard cannot read what else it does',
  },
  {
    name: 'disk or device write',
    pattern: /\b(?:dd\s+[^|;&]*of=\/dev\/|mkfs\b|diskpart\b)/i,
    decision: 'deny',
    reason: 'the command writes to a raw disk or formats one',
  },
];

/** Findings of the Bash rules for one command string, worst first. */
export function scanBashCommand(command: string): BashFinding[] {
  const findings: BashFinding[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(command)) findings.push({ decision: rule.decision, reason: rule.reason });
  }
  return findings.sort((a, b) => (a.decision === b.decision ? 0 : a.decision === 'deny' ? -1 : 1));
}
