import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL_RULES, globToRegExp, hideReason, resolveCapabilities, ruleChain, shouldHide } from '../config/modelRules';

describe('globToRegExp', () => {
	test('anchors the pattern', () => {
		assert.ok(globToRegExp('gpt-4o').test('gpt-4o'));
		assert.ok(!globToRegExp('gpt-4o').test('my-gpt-4o-preview'));
	});

	test('matches case-insensitively', () => {
		assert.ok(globToRegExp('claude-*').test('Claude-Sonnet-4'));
	});

	test('supports * and ?', () => {
		assert.ok(globToRegExp('gpt-?').test('gpt-4'));
		assert.ok(!globToRegExp('gpt-?').test('gpt-4o'));
		assert.ok(globToRegExp('*llama*').test('meta-llama/Llama-3-8B'));
	});

	test('escapes regex metacharacters', () => {
		assert.ok(globToRegExp('gpt-4.1').test('gpt-4.1'));
		assert.ok(!globToRegExp('gpt-4.1').test('gpt-4x1'));
	});
});

describe('resolveCapabilities', () => {
	test('applies a built-in rule', () => {
		const caps = resolveCapabilities('gpt-4o-2024-11-20', ruleChain([]));
		assert.equal(caps.matched, true);
		assert.equal(caps.toolCalling, true);
		assert.equal(caps.imageInput, true);
	});

	test('a specific built-in rule is not undone by the generic one of its family', () => {
		// `gpt-4*` also matches `gpt-4o-*`, so ordering inside DEFAULT_MODEL_RULES
		// decides the outcome. This guards that invariant, not just the value.
		const gpt4o = resolveCapabilities('gpt-4o-2024-11-20', ruleChain([]));
		assert.equal(gpt4o.imageInput, true);
		assert.equal(gpt4o.maxOutputTokens, 16384);

		const gpt41 = resolveCapabilities('gpt-4.1-mini', ruleChain([]));
		assert.equal(gpt41.maxInputTokens, 1000000);

		const plainGpt4 = resolveCapabilities('gpt-4-turbo', ruleChain([]));
		assert.equal(plainGpt4.imageInput, false);
	});

	test('user rules override built-in rules', () => {
		const caps = resolveCapabilities('claude-sonnet-4', ruleChain([{ match: 'claude-*', toolCalling: 8, maxInputTokens: 500000 }]));
		assert.equal(caps.toolCalling, 8);
		assert.equal(caps.maxInputTokens, 500000);
		// Untouched fields keep the built-in value.
		assert.equal(caps.imageInput, true);
	});

	test('later matching rules win over earlier ones', () => {
		const caps = resolveCapabilities('custom-x', [
			{ match: 'custom-*', toolCalling: true },
			{ match: '*-x', toolCalling: false },
		]);
		assert.equal(caps.toolCalling, false);
	});

	test('reports no match for an unknown model', () => {
		const caps = resolveCapabilities('some-internal-model-v9', ruleChain([]));
		assert.equal(caps.matched, false);
		assert.equal(caps.toolCalling, false);
	});

	test('ignores malformed rules', () => {
		const caps = resolveCapabilities('gpt-4o', [null as never, { match: 42 as never }, { match: 'gpt-4o', imageInput: false }]);
		assert.equal(caps.imageInput, false);
	});

	test('rejects non-positive token limits', () => {
		const caps = resolveCapabilities('gpt-4o', ruleChain([{ match: 'gpt-4o', maxInputTokens: 0 }]));
		assert.equal(caps.maxInputTokens, 128000);
	});
});

describe('shouldHide', () => {
	test('hides embedding and audio endpoints by default', () => {
		for (const id of ['text-embedding-3-large', 'bge-reranker-v2', 'whisper-1', 'dall-e-3']) {
			const caps = resolveCapabilities(id, ruleChain([]));
			assert.equal(shouldHide(caps, false), true, id);
		}
	});

	test('hides unknown models only when configured to', () => {
		const caps = resolveCapabilities('mystery-model', ruleChain([]));
		assert.equal(shouldHide(caps, true), true);
		assert.equal(shouldHide(caps, false), false);
	});

	test('a user rule can re-expose a hidden model', () => {
		const caps = resolveCapabilities(
			'text-embedding-3-large',
			ruleChain([{ match: 'text-embedding-3-large', hide: false, toolCalling: false }]),
		);
		assert.equal(shouldHide(caps, true), false);
	});

	test('distinguishes an explicit hide rule from an unmatched model', () => {
		const byRule = resolveCapabilities('text-embedding-3-large', ruleChain([]));
		assert.equal(hideReason(byRule, false), 'rule');

		const unknown = resolveCapabilities('acme-internal-v2', ruleChain([]));
		assert.equal(hideReason(unknown, true), 'unknown');
		assert.equal(hideReason(unknown, false), undefined);

		const offered = resolveCapabilities('gpt-4o', ruleChain([]));
		assert.equal(hideReason(offered, true), undefined);
	});

	test('every built-in rule carries a usable match', () => {
		for (const rule of DEFAULT_MODEL_RULES) {
			assert.equal(typeof rule.match, 'string');
			assert.ok(rule.match.length > 0);
		}
	});
});
