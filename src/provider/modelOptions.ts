/**
 * Filtering of caller-supplied `modelOptions`.
 *
 * Kept free of a `vscode` import so it stays unit-testable — the bug this
 * guards against only shows up against a strict endpoint, which is exactly the
 * case a test has to stand in for.
 */

/**
 * Sampling parameters forwarded from the caller's `modelOptions`.
 *
 * `modelOptions` is whatever the calling extension put there, and Copilot Chat
 * injects private bookkeeping fields (`_otelTraceContext`, `_enableThinking`,
 * `_telemetryTurnNo`, `_capturingTokenCorrelationId`). Azure — and any gateway
 * in front of it — rejects the whole request with
 * "Unrecognized request arguments supplied", so the caller's options are
 * filtered rather than passed through.
 *
 * This deliberately does not apply to `workspaceKeys.requestDefaults`: those are
 * authored by the user for their own endpoint and are the escape hatch for
 * provider-specific parameters that are not listed here.
 */
export const FORWARDABLE_MODEL_OPTIONS: ReadonlySet<string> = new Set([
	// OpenAI chat completions
	'temperature',
	'top_p',
	'n',
	'stop',
	'max_tokens',
	'max_completion_tokens',
	'presence_penalty',
	'frequency_penalty',
	'logit_bias',
	'logprobs',
	'top_logprobs',
	'seed',
	'user',
	'response_format',
	'parallel_tool_calls',
	'reasoning_effort',
	'service_tier',
	'stream_options',
	'modalities',
	'prediction',
	'store',
	'metadata',
	// Commonly accepted by vLLM / Ollama / TGI style gateways
	'top_k',
	'min_p',
	'repetition_penalty',
]);

export function sanitizeModelOptions(options: { readonly [name: string]: any } | undefined): {
	forwarded: Record<string, unknown>;
	dropped: string[];
} {
	const forwarded: Record<string, unknown> = {};
	const dropped: string[] = [];

	for (const [name, value] of Object.entries(options ?? {})) {
		if (FORWARDABLE_MODEL_OPTIONS.has(name)) {
			forwarded[name] = value;
		} else {
			dropped.push(name);
		}
	}
	return { forwarded, dropped };
}

/**
 * Merges the request parameters: the model rule's output limit first, then
 * workspace defaults, then the caller's (already filtered) options.
 *
 * Reasoning-model endpoints accept only `max_completion_tokens` and reject a
 * request that carries `max_tokens` alongside it, so the presence of one
 * removes the other — this is also the only way to *not* send `max_tokens`.
 */
export function mergeRequestParameters(
	maxOutputTokens: number,
	defaults: Record<string, unknown>,
	forwarded: Record<string, unknown>,
): Record<string, unknown> {
	const parameters: Record<string, unknown> = {
		max_tokens: maxOutputTokens,
		...defaults,
		// Caller options win over workspace defaults, but only the known ones.
		...forwarded,
	};
	if (parameters.max_completion_tokens !== undefined) {
		delete parameters.max_tokens;
	}
	return parameters;
}
