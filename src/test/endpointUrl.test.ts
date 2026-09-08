import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost, validateBaseUrl } from '../security/endpointUrl';

describe('base URL validation', () => {
	test('accepts an https URL and strips trailing slashes', () => {
		const result = validateBaseUrl('https://api.example.com/v1/');
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.baseUrl, 'https://api.example.com/v1');
		assert.equal(result.ok && result.origin, 'https://api.example.com');
	});

	test('keeps a non-default port', () => {
		const result = validateBaseUrl('https://api.example.com:8443/v1');
		assert.equal(result.ok && result.baseUrl, 'https://api.example.com:8443/v1');
	});

	test('accepts an https URL without a path', () => {
		const result = validateBaseUrl('https://api.example.com');
		assert.equal(result.ok && result.baseUrl, 'https://api.example.com');
	});

	// A bearer token and the whole prompt travel in the request, so cleartext
	// transport must not be reachable by accident.
	test('rejects remote http even with the development opt-in', () => {
		for (const allowInsecureLoopback of [false, true]) {
			const result = validateBaseUrl('http://api.example.com/v1', { allowInsecureLoopback });
			assert.equal(result.ok, false);
			assert.equal(!result.ok && result.problem, 'insecure');
		}
	});

	test('rejects loopback http unless the development opt-in is set', () => {
		for (const url of ['http://localhost:8787/v1', 'http://127.0.0.1:8787/v1', 'http://[::1]:8787/v1']) {
			assert.equal(validateBaseUrl(url).ok, false, url);
			assert.equal(validateBaseUrl(url, { allowInsecureLoopback: true }).ok, true, url);
		}
	});

	test('rejects credentials in the URL', () => {
		const result = validateBaseUrl('https://user:secret@api.example.com/v1');
		assert.equal(!result.ok && result.problem, 'credentials');
	});

	test('rejects a query string or fragment, where a key would end up in logs', () => {
		assert.equal(!validateBaseUrl('https://api.example.com/v1?api-key=abc').ok, true);
		assert.equal(!validateBaseUrl('https://api.example.com/v1#token').ok, true);
	});

	test('rejects other schemes and unparsable input', () => {
		assert.equal(!validateBaseUrl('ftp://api.example.com').ok, true);
		assert.equal(!validateBaseUrl('file:///etc/passwd').ok, true);
		assert.equal(!validateBaseUrl('api.example.com/v1').ok, true);
		assert.equal(!validateBaseUrl('   ').ok, true);
	});

	test('every rejection carries a message that can be shown as-is', () => {
		const result = validateBaseUrl('http://api.example.com');
		assert.equal(result.ok, false);
		assert.ok(!result.ok && result.message.length > 0);
	});

	test('isLoopbackHost covers the 127/8 literals and the IPv6 literal', () => {
		assert.equal(isLoopbackHost('localhost'), true);
		assert.equal(isLoopbackHost('127.0.0.1'), true);
		assert.equal(isLoopbackHost('127.1.2.3'), true);
		assert.equal(isLoopbackHost('[::1]'), true);
		assert.equal(isLoopbackHost('example.com'), false);
		// A name that merely starts with "127." resolves wherever its owner says.
		assert.equal(isLoopbackHost('127.example.com'), false);
	});

	test('a host that only looks like loopback does not get the http exemption', () => {
		const result = validateBaseUrl('http://127.example.com/v1', { allowInsecureLoopback: true });
		assert.equal(!result.ok && result.problem, 'insecure');
	});
});
