import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { containsEnvRef, interpolateEnv } from '../auth/env';
import { isOwnSecret, secretName, workspaceHash } from '../auth/secretKey';
import { composeModelId, splitModelId } from '../provider/modelId';

describe('interpolateEnv', () => {
	test('substitutes a set variable', () => {
		assert.deepEqual(interpolateEnv('${env:MY_KEY}', { MY_KEY: 'sk-abc' }), { value: 'sk-abc', missing: [] });
	});

	test('leaves an unset variable in place and reports it', () => {
		const result = interpolateEnv('${env:ABSENT}', {});
		assert.deepEqual(result.missing, ['ABSENT']);
		assert.equal(result.value, '${env:ABSENT}');
	});

	test('treats an empty variable as unset', () => {
		assert.deepEqual(interpolateEnv('${env:EMPTY}', { EMPTY: '' }).missing, ['EMPTY']);
	});

	test('handles several references and reports each name once', () => {
		const result = interpolateEnv('${env:A}-${env:B}-${env:A}', { B: 'b' });
		assert.deepEqual(result.missing, ['A']);
	});

	test('supports a prefix around the reference', () => {
		assert.equal(interpolateEnv('Bearer ${env:T}', { T: 'x' }).value, 'Bearer x');
	});

	test('detects whether a reference is present', () => {
		assert.equal(containsEnvRef('${env:X}'), true);
		assert.equal(containsEnvRef('sk-literal'), false);
		// The pattern is global; repeated calls must not be affected by lastIndex.
		assert.equal(containsEnvRef('${env:X}'), true);
		assert.equal(containsEnvRef('${env:X}'), true);
	});

	test('ignores malformed references', () => {
		assert.equal(containsEnvRef('${env:}'), false);
		assert.equal(containsEnvRef('${env:1BAD}'), false);
		assert.equal(interpolateEnv('${ENV:X}', { X: 'y' }).value, '${ENV:X}');
	});
});

describe('secret names', () => {
	test('are stable for the same workspace', () => {
		assert.equal(workspaceHash('file:///c/work/a'), workspaceHash('file:///c/work/a'));
	});

	test('differ per workspace', () => {
		assert.notEqual(workspaceHash('file:///c/work/a'), workspaceHash('file:///c/work/b'));
	});

	test('carry the provider id and are recognisable', () => {
		const name = secretName('openai', workspaceHash('file:///c/work/a'));
		assert.match(name, /^workspace-keys:openai:[0-9a-f]{16}$/);
		assert.equal(isOwnSecret(name), true);
		assert.equal(isOwnSecret('some.other.extension.key'), false);
	});
});

describe('model ids', () => {
	test('round-trip through a provider prefix', () => {
		const composed = composeModelId('azure', 'gpt-4o');
		assert.equal(composed, 'azure/gpt-4o');
		assert.deepEqual(splitModelId(composed), { providerId: 'azure', modelId: 'gpt-4o' });
	});

	test('keep slashes inside the model id', () => {
		const composed = composeModelId('local', 'meta-llama/Llama-3-8B-Instruct');
		assert.deepEqual(splitModelId(composed), { providerId: 'local', modelId: 'meta-llama/Llama-3-8B-Instruct' });
	});

	test('reject ids without a usable separator', () => {
		assert.equal(splitModelId('noslash'), undefined);
		assert.equal(splitModelId('/leading'), undefined);
		assert.equal(splitModelId('trailing/'), undefined);
	});
});
