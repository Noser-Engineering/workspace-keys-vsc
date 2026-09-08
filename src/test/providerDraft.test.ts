import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveProviderId, sanitizeProviderTitle, suggestProviderTitle } from '../config/providerDraft';

describe('provider title suggestion', () => {
	test('uses the main domain, capitalised', () => {
		assert.equal(suggestProviderTitle('https://models.example.com/v1'), 'Example');
		assert.equal(suggestProviderTitle('https://api.example.com/v1'), 'Example');
		assert.equal(suggestProviderTitle('https://example.com/v1'), 'Example');
	});

	test('ignores deeper subdomains', () => {
		assert.equal(suggestProviderTitle('https://eu.api.gateway.example.com/v1'), 'Example');
	});

	test('handles second-level suffixes', () => {
		assert.equal(suggestProviderTitle('https://api.example.co.uk/v1'), 'Example');
		assert.equal(suggestProviderTitle('https://example.com.au/v1'), 'Example');
	});

	test('keeps host and port for loopback and literal addresses', () => {
		assert.equal(suggestProviderTitle('http://localhost:8787/v1'), 'Localhost:8787');
		assert.equal(suggestProviderTitle('http://127.0.0.1:8788/v1'), '127.0.0.1:8788');
		assert.equal(suggestProviderTitle('http://[::1]:8789/v1'), '::1:8789');
	});

	test('falls back rather than returning nothing', () => {
		assert.equal(suggestProviderTitle('not a url'), 'Provider');
	});
});

describe('provider title sanitising', () => {
	test('removes control characters and collapses whitespace', () => {
		assert.equal(sanitizeProviderTitle('  Acme\u0000\tGateway \n'), 'Acme Gateway');
	});

	test('caps the length so a status bar entry stays readable', () => {
		assert.equal(sanitizeProviderTitle('x'.repeat(200)).length, 60);
	});

	test('an all-whitespace title is empty, which callers treat as no title', () => {
		assert.equal(sanitizeProviderTitle('   \t '), '');
	});
});

describe('provider id derivation', () => {
	test('reduces a title to the characters a SecretStorage name may hold', () => {
		assert.equal(deriveProviderId('Acme Gateway'), 'Acme-Gateway');
		assert.equal(deriveProviderId('Example'), 'Example');
		assert.equal(deriveProviderId('127.0.0.1:8787'), '127.0.0.1-8787');
	});

	test('collapses and trims separators', () => {
		assert.equal(deriveProviderId('  Acme   //  Gateway  '), 'Acme-Gateway');
		assert.equal(deriveProviderId('***'), 'provider');
	});

	// Two entries sharing an id would share one stored key.
	test('suffixes a collision instead of reusing an id', () => {
		assert.equal(deriveProviderId('Example', ['Example']), 'Example-2');
		assert.equal(deriveProviderId('Example', ['Example', 'Example-2']), 'Example-3');
	});

	test('the derived id is always usable as a provider id', () => {
		for (const title of ['Acme Gateway', 'Ünïcödé', '///', '127.0.0.1:8787', 'a'.repeat(80)]) {
			assert.match(deriveProviderId(title), /^[A-Za-z0-9._-]+$/, title);
		}
	});
});
