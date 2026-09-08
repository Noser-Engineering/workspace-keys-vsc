import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderConfig } from '../types';
import { buildRequestHeaders, sanitizeCustomHeaders } from '../provider/headers';

const PROVIDER: ProviderConfig = { id: 'example', baseUrl: 'https://api.example.com/v1' };

describe('custom header sanitising', () => {
	test('keeps ordinary headers', () => {
		const { headers, rejected } = sanitizeCustomHeaders({ 'X-Tenant': 'acme', 'X-Trace': '1' });
		assert.deepEqual(headers, { 'X-Tenant': 'acme', 'X-Trace': '1' });
		assert.deepEqual(rejected, []);
	});

	test('drops reserved headers regardless of casing or padding', () => {
		const { headers, rejected } = sanitizeCustomHeaders({
			Authorization: 'Bearer attacker',
			'PROXY-AUTHORIZATION': 'Basic x',
			' cookie ': 'session=1',
			Host: 'evil.example.com',
			'content-type': 'text/plain',
			ACCEPT: 'application/xml',
			'Content-Length': '0',
		});
		assert.deepEqual(headers, {});
		assert.equal(rejected.length, 7);
	});

	test('drops syntactically impossible header names', () => {
		const { headers, rejected } = sanitizeCustomHeaders({ 'X Bad': 'v', 'X-Good': 'v' });
		assert.deepEqual(headers, { 'X-Good': 'v' });
		assert.deepEqual(rejected, ['X Bad']);
	});
});

describe('request header assembly', () => {
	// The credential must survive arbitrary user input, whatever it is named.
	test('a configured Authorization header cannot replace the resolved key', () => {
		const { headers } = buildRequestHeaders({ ...PROVIDER, headers: { Authorization: 'Bearer attacker' } }, 'real-key');
		assert.equal(headers.Authorization, 'Bearer real-key');
	});

	test('protocol headers are not overridable either', () => {
		const { headers } = buildRequestHeaders(
			{ ...PROVIDER, headers: { 'Content-Type': 'text/plain', Accept: 'application/xml' } },
			'real-key',
		);
		assert.equal(headers['Content-Type'], 'application/json');
		assert.equal(headers.Accept, 'text/event-stream');
	});

	test('the caller may still override Accept for model discovery', () => {
		const { headers } = buildRequestHeaders(PROVIDER, 'real-key', { Accept: 'application/json' });
		assert.equal(headers.Accept, 'application/json');
		assert.equal(headers.Authorization, 'Bearer real-key');
	});

	test('allowed custom headers survive', () => {
		const { headers, rejected } = buildRequestHeaders({ ...PROVIDER, headers: { 'X-Tenant': 'acme' } }, 'real-key');
		assert.equal(headers['X-Tenant'], 'acme');
		assert.deepEqual(rejected, []);
	});

	test('a provider without headers still gets the full set', () => {
		const { headers } = buildRequestHeaders(PROVIDER, 'real-key');
		assert.deepEqual(Object.keys(headers).sort(), ['Accept', 'Authorization', 'Content-Type']);
	});
});
