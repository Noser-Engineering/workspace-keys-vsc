import type { ModelRule } from '../types';

/** Matches LiteLLM deployment metadata to the public model names returned by /models. */
export function modelInfoRules(body: unknown, visibleIds: readonly string[]): Map<string, ModelRule> {
	const rules = new Map<string, ModelRule>();
	if (!isObject(body) || !Array.isArray(body.data)) {
		return rules;
	}

	const visible = new Set(visibleIds);
	for (const entry of body.data) {
		if (!isObject(entry) || typeof entry.model_name !== 'string' || !visible.has(entry.model_name) || !isObject(entry.model_info)) {
			continue;
		}
		const info = entry.model_info;
		const rule: ModelRule = { match: entry.model_name };
		if (typeof info.mode === 'string' && info.mode !== 'chat' && info.mode !== 'responses') {
			rule.hide = true;
		}
		if (typeof info.supports_function_calling === 'boolean') {
			rule.toolCalling = info.supports_function_calling;
		}
		if (typeof info.supports_vision === 'boolean') {
			rule.imageInput = info.supports_vision;
		}
		if (positiveInteger(info.max_input_tokens)) {
			rule.maxInputTokens = info.max_input_tokens;
		}
		if (positiveInteger(info.max_output_tokens)) {
			rule.maxOutputTokens = info.max_output_tokens;
		}
		if (Object.keys(rule).length === 1 && info.mode !== 'chat' && info.mode !== 'responses') {
			continue;
		}

		const previous = rules.get(entry.model_name);
		if (!previous) {
			rules.set(entry.model_name, rule);
		} else {
			// LiteLLM can route one public name to several deployments.
			if (rule.hide) {
				previous.hide = true;
			}
			previous.toolCalling = previous.toolCalling === true && rule.toolCalling === true;
			previous.imageInput = previous.imageInput === true && rule.imageInput === true;
			previous.maxInputTokens = Math.min(previous.maxInputTokens ?? 8192, rule.maxInputTokens ?? 8192);
			previous.maxOutputTokens = Math.min(previous.maxOutputTokens ?? 4096, rule.maxOutputTokens ?? 4096);
		}
	}
	return rules;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
