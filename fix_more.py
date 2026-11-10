import os
os.chdir(r"C:/Users/user/AppData/Local/Temp/claude/7103becfe0c065f2/e8b10441-bb0e-44e6-8bca-b1a5e87edf01/scratchpad/colony-core/src")
def edit(p, pairs):
    s = open(p, encoding='utf-8', newline='').read()
    crlf = '\r\n' in s
    t = s.replace('\r\n', '\n')
    for a, b in pairs:
        assert a in t, (p, a[:70])
        t = t.replace(a, b, 1)
    open(p, 'w', encoding='utf-8', newline='').write(t.replace('\n', '\r\n') if crlf else t)

edit('cli/session.ts', [
 ("const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');",
  """const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

async function readIntegrity(stateDir: string): Promise<IntegrityRecord | null> {
  const text = await readIfExists(path.join(stateDir, INTEGRITY_FILE));
  if (text === null) return null; // a state from before this check: the next save writes one
  try {
    const parsed = JSON.parse(text);
    return parsed?.v === 1 && typeof parsed.ledger === 'string' && typeof parsed.audit?.entries === 'number' && typeof parsed.audit?.head === 'string' ? (parsed as IntegrityRecord) : null;
  } catch {
    return null;
  }
}"""),
])

edit('cli/context.ts', [
 ("  'verified-by-test': { type: 'boolean' },", "  'verified-by-test': { type: 'boolean' },\n  'accept-changes': { type: 'boolean' },"),
])
edit('cli/commands.ts', [
 ("await ColonySession.boot(dir)", "await ColonySession.boot(dir, { acceptExternalChanges: Boolean(values['accept-changes']) })"),
 ("  rate <taskId> --quality 0..1", "  boot [--accept-changes]                 load the state; --accept-changes takes a ledger/audit edited outside the colony as it is (after you reviewed it)\n  rate <taskId> --quality 0..1"),
])

# consensus engine: expireDue, input validation
edit('consensus/consensus-engine.ts', [
 ("    const timeoutMs = options.timeoutMs || 30000;\n",
  "    if (options.timeoutMs !== undefined && !(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0)) throw new Error('timeoutMs must be a positive number of milliseconds');\n    if (options.quorum !== undefined && !(Number.isInteger(options.quorum) && options.quorum >= 1)) throw new Error('quorum must be a positive integer');\n    const timeoutMs = options.timeoutMs ?? 30000;\n"),
 ("options.quorum || 2;", "options.quorum ?? 2;"),
 ("  private evaluateProposal(proposal", """  /**
   * Close every open proposal that is past its deadline. Without this a proposal nobody votes on
   * stays `open` for ever; the deadline was only noticed when someone happened to vote.
   */
  public async expireDue(now: number = Date.now()): Promise<number> {
    let closed = 0;
    for (const proposal of this.proposals.values()) {
      if (proposal.status === 'open' && now > proposal.expiresAt) {
        proposal.status = 'timeout';
        closed++;
        await this.messageBus.publish('consensus:proposal_timeout', 'consensus_engine', { proposalId: proposal.id });
      }
    }
    return closed;
  }

  private evaluateProposal(proposal"""),
])
print('more ok')
