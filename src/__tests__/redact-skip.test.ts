import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText } from '../redact.js';

const text = 'Patch V8 to 13.6.233.17 and mail maintainer@example.com about it.';

test('by default a four-part version number is redacted as an IP address', () => {
  const r = redactText(text);
  assert.ok(r.text.includes('[REDACTED:ip_address]'));
  assert.deepEqual(r.findings.map((f) => f.kind), ['email', 'ip_address']);
});

test('skipping ip_address keeps the version and still redacts everything else', () => {
  const r = redactText(text, { skip: ['ip_address'] });
  assert.equal(r.text, 'Patch V8 to 13.6.233.17 and mail [REDACTED:email] about it.');
  assert.deepEqual(r.findings, [{ kind: 'email', count: 1 }]);
  assert.equal(r.changed, true);
  const only = redactText('V8 13.6.233.17', { skip: ['ip_address'] });
  assert.equal(only.text, 'V8 13.6.233.17');
  assert.equal(only.changed, false);
});

test('a secret can never be skipped, and an unknown kind is refused', () => {
  assert.throws(() => redactText('x', { skip: ['secret'] }), /secret is always redacted/);
  assert.throws(() => redactText('x', { skip: ['nonsense' as never] }), /unknown kind to skip/);
});

test('skipping works together with hashing of another kind', () => {
  const r = redactText(text, { skip: ['ip_address'], hash: ['email'], salt: 's' });
  assert.ok(r.text.includes('13.6.233.17'));
  assert.match(r.text, /\[HASH:email:[0-9a-f]{10}\]/);
});
