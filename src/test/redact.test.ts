import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BODY_LENGTH, redactHeaders, scrubSecret, truncateBody } from '../util/redact';

describe('header redaction', () => {
	test('keeps only headers known to be uninteresting', () => {
		const safe = redactHeaders({
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
			Authorization: 'Bearer sk-secret',
			'X-Tenant': 'acme',
		});
		assert.equal(safe['Content-Type'], 'application/json');
		assert.equal(safe.Accept, 'text/event-stream');
		assert.equal(safe.Authorization, '<redacted>');
		assert.equal(safe['X-Tenant'], '<redacted>');
	});

	// A credential can arrive under any header name, so the rule has to be an
	// allowlist rather than a list of known-sensitive names.
	test('a credential under an unexpected name is redacted too', () => {
		const safe = redactHeaders({ 'X-Auth-Token': 'sk-secret', 'api-key': 'sk-secret' });
		assert.equal(safe['X-Auth-Token'], '<redacted>');
		assert.equal(safe['api-key'], '<redacted>');
	});

	test('casing does not matter', () => {
		assert.equal(redactHeaders({ AUTHORIZATION: 'Bearer x' }).AUTHORIZATION, '<redacted>');
		assert.equal(redactHeaders({ accept: 'application/json' }).accept, 'application/json');
	});
});

describe('secret scrubbing', () => {
	test('removes the key from an echoed error body', () => {
		assert.equal(scrubSecret('invalid key sk-abcdef123456', 'sk-abcdef123456'), 'invalid key <redacted>');
	});

	// Length is not a reason to leave a secret in place.
	test('a short key is still a key', () => {
		assert.equal(scrubSecret('token=abc', 'abc'), 'token=<redacted>');
		assert.equal(scrubSecret('x', 'x'), '<redacted>');
	});

	test('every occurrence is replaced', () => {
		assert.equal(scrubSecret('abc and abc', 'abc'), '<redacted> and <redacted>');
	});

	test('no key means no change', () => {
		assert.equal(scrubSecret('body', undefined), 'body');
		assert.equal(scrubSecret('body', ''), 'body');
	});
});

describe('body truncation', () => {
	test('leaves a short body alone', () => {
		assert.equal(truncateBody('short'), 'short');
	});

	test('caps a long body and says so', () => {
		const result = truncateBody('x'.repeat(MAX_BODY_LENGTH + 100));
		assert.ok(result.length < MAX_BODY_LENGTH + 100);
		assert.match(result, /truncated/);
	});
});
