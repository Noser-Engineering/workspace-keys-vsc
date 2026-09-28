import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { modelInfoRules } from '../provider/modelInfo';
import { hideReason, resolveCapabilities, ruleChain } from '../config/modelRules';

describe('LiteLLM model metadata', () => {
	test('maps responses models and non-chat modes by public model name, not underlying deployment', () => {
		const rules = modelInfoRules(
			{
				data: [
					{
						model_name: 'gpt-6-sol',
						litellm_params: { model: 'azure/gpt-6-sol' },
						model_info: {
							mode: 'responses',
							supports_function_calling: true,
							supports_vision: true,
							max_input_tokens: 922000,
							max_output_tokens: 128000,
						},
					},
					{ model_name: 'vector-search', model_info: { mode: 'embedding' } },
					{ model_name: 'private', model_info: { mode: 'chat', supports_function_calling: true } },
				],
			},
			['gpt-6-sol', 'vector-search'],
		);
		assert.equal(rules.has('private'), false);
		const caps = resolveCapabilities('gpt-6-sol', [...ruleChain([]), rules.get('gpt-6-sol')!]);
		assert.equal(hideReason(caps, true), undefined);
		assert.equal(caps.toolCalling, true);
		assert.equal(caps.imageInput, true);
		assert.equal(caps.maxInputTokens, 922000);
		assert.equal(caps.maxOutputTokens, 128000);
		assert.equal(hideReason(resolveCapabilities('vector-search', [...ruleChain([]), rules.get('vector-search')!]), false), 'rule');
	});

	test('never lets metadata unhide a built-in non-chat rule; user rules can override metadata', () => {
		const rule = modelInfoRules(
			{
				data: [
					{ model_name: 'text-embedding-3', model_info: { mode: 'chat' } },
					{ model_name: 'gpt-5-special', model_info: { mode: 'chat', supports_function_calling: false } },
				],
			},
			['text-embedding-3', 'gpt-5-special'],
		);
		assert.equal(hideReason(resolveCapabilities('text-embedding-3', [...ruleChain([]), rule.get('text-embedding-3')!]), false), 'rule');
		const caps = resolveCapabilities('gpt-5-special', [
			...ruleChain([]),
			rule.get('gpt-5-special')!,
			{ match: 'gpt-5-special', toolCalling: true },
		]);
		assert.equal(caps.toolCalling, true);
	});

	test('uses the weakest capabilities across deployments and ignores invalid values', () => {
		const rules = modelInfoRules(
			{
				data: [
					{
						model_name: 'shared',
						model_info: {
							mode: 'chat',
							supports_function_calling: true,
							supports_vision: true,
							max_input_tokens: 128000,
							max_output_tokens: 16000,
						},
					},
					{
						model_name: 'shared',
						model_info: {
							mode: 'responses',
							supports_function_calling: false,
							supports_vision: false,
							max_input_tokens: 32000,
							max_output_tokens: -1,
						},
					},
				],
			},
			['shared'],
		);
		assert.deepEqual(rules.get('shared'), {
			match: 'shared',
			toolCalling: false,
			imageInput: false,
			maxInputTokens: 32000,
			maxOutputTokens: 4096,
		});
		assert.equal(modelInfoRules({ data: [{ model_name: 'shared', model_info: {} }] }, ['shared']).size, 0);
	});
});
