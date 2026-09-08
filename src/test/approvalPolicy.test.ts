import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isEndpointApproved, originOf } from '../security/approvalPolicy';

describe('endpoint approval', () => {
	test('a provider from user settings is always approved', () => {
		assert.equal(isEndpointApproved('https://api.example.com/v1', 'user', []), true);
		assert.equal(isEndpointApproved('http://127.0.0.1:9999/v1', 'user', []), true);
	});

	test('a provider from workspace settings needs its origin on the list', () => {
		assert.equal(isEndpointApproved('https://api.example.com/v1', 'workspace', []), false);
		assert.equal(isEndpointApproved('https://api.example.com/v1', 'workspace', ['https://api.example.com']), true);
	});

	// Loopback is where a malicious local process would listen, so a cloned
	// repository pointing at one must not be approved silently.
	test('loopback from workspace settings is not exempt', () => {
		assert.equal(isEndpointApproved('http://127.0.0.1:9999/v1', 'workspace', []), false);
		assert.equal(isEndpointApproved('http://localhost:9999/v1', 'workspace', []), false);
		assert.equal(isEndpointApproved('http://[::1]:9999/v1', 'workspace', []), false);
	});

	test('approval is per origin, so a path difference does not matter', () => {
		assert.equal(isEndpointApproved('https://api.example.com/v2/other', 'workspace', ['https://api.example.com']), true);
	});

	test('a different port is a different origin', () => {
		assert.equal(isEndpointApproved('http://127.0.0.1:9998/v1', 'workspace', ['http://127.0.0.1:9999']), false);
	});

	test('an unparsable URL is never approved', () => {
		assert.equal(isEndpointApproved('not a url', 'workspace', []), false);
		assert.equal(isEndpointApproved('not a url', 'user', []), false);
	});

	test('originOf reduces a base URL to its origin', () => {
		assert.equal(originOf('https://api.example.com:8443/v1/models'), 'https://api.example.com:8443');
		assert.equal(originOf('nonsense'), undefined);
	});
});
