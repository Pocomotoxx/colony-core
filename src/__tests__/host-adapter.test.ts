import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILE_TOOLS, PRETOOL_MATCHER, preToolUseOutput, SHELL_TOOLS, toHostRequest } from '../host/claude-code.js';
import { evaluateToolCall } from '../hook/pretool.js';
import type { ToolCall } from '../host/types.js';

// The payload below is the shape a live Claude Code 2.1.281 session sent (see the README).
const livePayload = {
  session_id: 'da441dc5-b702-496b-80a8-c13d68fbd897',
  transcript_path: '/home/u/.claude/t.jsonl',
  cwd: '/home/u/project',
  prompt_id: 'p1',
  permission_mode: 'acceptEdits',
  effort: 'high',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hacked > ./.colony/ledger.json', description: 'Write hacked' },
  tool_use_id: 'toolu_01',
};

test('the adapter turns a Claude Code payload into a host-neutral request, with the session', () => {
  const r = toHostRequest(livePayload);
  assert.deepEqual(r.call, { kind: 'shell', command: 'echo hacked > ./.colony/ledger.json' });
  assert.deepEqual(r.session, { id: 'da441dc5-b702-496b-80a8-c13d68fbd897', cwd: '/home/u/project' });
});

test('every shell and file tool maps to a neutral kind; anything else is "other"; junk does not throw', () => {
  for (const tool of SHELL_TOOLS) assert.equal(toHostRequest({ tool_name: tool, tool_input: { command: 'ls' } }).call.kind, 'shell');
  const w = toHostRequest({ tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'x' } }).call;
  assert.deepEqual(w, { kind: 'file-write', tool: 'Write', path: 'a.txt', texts: ['x'] });
  const m = toHostRequest({ tool_name: 'MultiEdit', tool_input: { file_path: 'a', edits: [{ new_string: '1' }, { new_string: '2' }] } }).call;
  assert.deepEqual(m, { kind: 'file-write', tool: 'MultiEdit', path: 'a', texts: ['1', '2'] });
  const n = toHostRequest({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'n.ipynb', new_source: 'print(1)' } }).call;
  assert.deepEqual(n, { kind: 'file-write', tool: 'NotebookEdit', path: 'n.ipynb', texts: ['print(1)'] });
  assert.deepEqual(toHostRequest({ tool_name: 'Read', tool_input: {} }).call, { kind: 'other', name: 'Read' });
  for (const junk of [null, undefined, 5, 'x', [], { tool_name: 7 }]) assert.doesNotThrow(() => toHostRequest(junk));
  assert.deepEqual(toHostRequest({}).session, { id: undefined, cwd: undefined });
});

test('the matcher covers exactly the tools the adapter understands', () => {
  assert.deepEqual(PRETOOL_MATCHER.split('|').sort(), [...SHELL_TOOLS, ...Object.keys(FILE_TOOLS)].sort());
});

test('the hook answer: nothing for allow, the host JSON for deny and ask', () => {
  assert.equal(preToolUseOutput({ decision: 'allow', reason: '', gates: [], notes: [] }), '');
  const out = JSON.parse(preToolUseOutput({ decision: 'ask', reason: 'why', gates: [], notes: [] }));
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'why' } });
});

test('the guard works on host-neutral calls: another host needs only its own adapter', async () => {
  const project = process.cwd();
  const calls: Array<[ToolCall, string]> = [
    [{ kind: 'shell', command: 'echo x > .colony/ledger.json' }, 'deny'],
    [{ kind: 'shell', command: 'git status' }, 'allow'],
    [{ kind: 'file-write', tool: 'Write', path: '../outside.txt', texts: ['x'] }, 'deny'],
    [{ kind: 'file-write', tool: 'Write', path: undefined, texts: [] }, 'deny'],
    [{ kind: 'other', name: 'Whatever' }, 'allow'],
  ];
  for (const [call, expected] of calls) assert.equal((await evaluateToolCall(call, project)).decision, expected, JSON.stringify(call));
});
