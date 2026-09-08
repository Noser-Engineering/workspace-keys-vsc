import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FORWARDABLE_MODEL_OPTIONS, mergeRequestParameters, sanitizeModelOptions } from '../provider/modelOptions';

/**
 * The exact set observed from Copilot Chat, which made Azure reject the whole
 * request with "Unrecognized request arguments supplied".
 */
const COPILOT_INTERNAL_FIELDS = {
	_capturingTokenCorrelationId: 'abc',
	_enableThinking: true,
	_otelTraceContext: { traceparent: '00-x-y-01' },
	_telemetryTurnNo: 3,
};

describe('sanitizeModelOptions', () => {
	test('drops the private fields Copilot Chat injects', () => {
		const { forwarded, dropped } = sanitizeModelOptions(COPILOT_INTERNAL_FIELDS);

		assert.deepEqual(forwarded, {});
		assert.deepEqual(dropped.sort(), ['_capturingTokenCorrelationId', '_enableThinking', '_otelTraceContext', '_telemetryTurnNo']);
	});

	test('keeps standard sampling parameters', () => {
		const { forwarded, dropped } = sanitizeModelOptions({
			temperature: 0.2,
			top_p: 0.9,
			max_tokens: 512,
			seed: 7,
			...COPILOT_INTERNAL_FIELDS,
		});

		assert.deepEqual(forwarded, { temperature: 0.2, top_p: 0.9, max_tokens: 512, seed: 7 });
		assert.equal(dropped.length, 4);
	});

	test('preserves falsy values rather than treating them as absent', () => {
		const { forwarded } = sanitizeModelOptions({ temperature: 0, store: false, stop: '' });
		assert.deepEqual(forwarded, { temperature: 0, store: false, stop: '' });
	});

	test('handles undefined and empty options', () => {
		assert.deepEqual(sanitizeModelOptions(undefined), { forwarded: {}, dropped: [] });
		assert.deepEqual(sanitizeModelOptions({}), { forwarded: {}, dropped: [] });
	});

	test('no forwardable parameter starts with an underscore', () => {
		// The failure mode was private fields reaching the wire; underscore-prefixed
		// names are private by convention and must never be on this list.
		for (const name of FORWARDABLE_MODEL_OPTIONS) {
			assert.ok(!name.startsWith('_'), name);
		}
	});
});

describe('mergeRequestParameters', () => {
	test('derives max_tokens from the model rule when nothing overrides it', () => {
		assert.deepEqual(mergeRequestParameters(4096, {}, {}), { max_tokens: 4096 });
	});

	test('lets workspace defaults override, and caller options override those', () => {
		assert.deepEqual(mergeRequestParameters(4096, { max_tokens: 1024, temperature: 0.2 }, { temperature: 0.7 }), {
			max_tokens: 1024,
			temperature: 0.7,
		});
	});

	// Reasoning-model endpoints reject a request carrying both fields.
	test('max_completion_tokens in the defaults removes max_tokens', () => {
		assert.deepEqual(mergeRequestParameters(4096, { max_completion_tokens: 2048 }, {}), { max_completion_tokens: 2048 });
	});

	test('max_completion_tokens from the caller removes max_tokens, even an explicit one', () => {
		assert.deepEqual(mergeRequestParameters(4096, { max_tokens: 1024 }, { max_completion_tokens: 2048 }), {
			max_completion_tokens: 2048,
		});
	});
});
