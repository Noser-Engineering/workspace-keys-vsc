import type { ModelRule, ResolvedCapabilities } from '../types';

/**
 * Built-in capability rules, applied before any user rule.
 *
 * These are heuristics keyed on common naming conventions, not authoritative
 * model metadata: an OpenAI-compatible `/models` endpoint reports ids but no
 * capabilities. Context sizes are deliberately conservative — an underestimate
 * costs some usable context, an overestimate produces server-side 400s. Users
 * override any of this via `workspaceKeys.modelRules`.
 *
 * Order matters: every matching rule is merged in sequence, so the broadest
 * pattern of a family has to come first and the more specific ones after it.
 * Listing `gpt-4o*` before `gpt-4*` would let the generic rule undo the
 * specific one, because `gpt-4*` also matches `gpt-4o-2024-11-20`.
 */
export const DEFAULT_MODEL_RULES: readonly ModelRule[] = [
	// OpenAI, broadest pattern first
	{ match: 'gpt-4*', toolCalling: true, imageInput: false, maxInputTokens: 128000, maxOutputTokens: 8192 },
	{ match: 'gpt-4o*', toolCalling: true, imageInput: true, maxInputTokens: 128000, maxOutputTokens: 16384 },
	{ match: 'gpt-4.1*', toolCalling: true, imageInput: true, maxInputTokens: 1000000, maxOutputTokens: 32768 },
	{ match: 'gpt-5*', toolCalling: true, imageInput: true, maxInputTokens: 272000, maxOutputTokens: 128000 },
	{ match: 'o1*', toolCalling: true, imageInput: true, maxInputTokens: 200000, maxOutputTokens: 100000 },
	{ match: 'o3*', toolCalling: true, imageInput: true, maxInputTokens: 200000, maxOutputTokens: 100000 },
	{ match: 'o4*', toolCalling: true, imageInput: true, maxInputTokens: 200000, maxOutputTokens: 100000 },

	// Anthropic, via an OpenAI-compatible gateway
	{ match: 'claude-*', toolCalling: true, imageInput: true, maxInputTokens: 200000, maxOutputTokens: 32000 },

	// Open-weight families commonly served by vLLM / Ollama / TGI
	{ match: 'qwen*', toolCalling: true, imageInput: false, maxInputTokens: 128000, maxOutputTokens: 8192 },
	{ match: 'llama*', toolCalling: true, imageInput: false, maxInputTokens: 128000, maxOutputTokens: 8192 },
	{ match: '*llama-3*', toolCalling: true, imageInput: false, maxInputTokens: 128000, maxOutputTokens: 8192 },
	{ match: 'mistral*', toolCalling: true, imageInput: false, maxInputTokens: 128000, maxOutputTokens: 8192 },
	{ match: 'mixtral*', toolCalling: true, imageInput: false, maxInputTokens: 64000, maxOutputTokens: 8192 },
	{ match: 'deepseek*', toolCalling: true, imageInput: false, maxInputTokens: 128000, maxOutputTokens: 8192 },
	{ match: 'gemma*', toolCalling: false, imageInput: false, maxInputTokens: 8192, maxOutputTokens: 4096 },
	{ match: 'phi*', toolCalling: false, imageInput: false, maxInputTokens: 128000, maxOutputTokens: 4096 },

	// Never offer non-chat endpoints as chat models.
	{ match: '*embed*', hide: true },
	{ match: 'text-embedding*', hide: true },
	{ match: '*rerank*', hide: true },
	{ match: 'whisper*', hide: true },
	{ match: 'tts-*', hide: true },
	{ match: 'dall-e*', hide: true },
];

/** Capabilities used when no rule matches and unknown models are not hidden. */
export const FALLBACK_CAPABILITIES: Readonly<Omit<ResolvedCapabilities, 'matched' | 'hide'>> = {
	toolCalling: false,
	imageInput: false,
	maxInputTokens: 8192,
	maxOutputTokens: 4096,
};

/** Translates a `*`/`?` glob into an anchored, case-insensitive RegExp. */
export function globToRegExp(pattern: string): RegExp {
	let out = '';
	for (const ch of pattern) {
		if (ch === '*') {
			out += '.*';
		} else if (ch === '?') {
			out += '.';
		} else {
			out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${out}$`, 'i');
}

/**
 * Merges every matching rule in order, so later rules override earlier fields.
 * User rules are expected to be appended after {@link DEFAULT_MODEL_RULES},
 * which is what makes them win.
 */
export function resolveCapabilities(modelId: string, rules: readonly ModelRule[]): ResolvedCapabilities {
	const resolved: ResolvedCapabilities = {
		...FALLBACK_CAPABILITIES,
		hide: false,
		matched: false,
	};

	for (const rule of rules) {
		if (!rule || typeof rule.match !== 'string' || !globToRegExp(rule.match).test(modelId)) {
			continue;
		}
		resolved.matched = true;
		if (rule.toolCalling !== undefined) {
			resolved.toolCalling = rule.toolCalling;
		}
		if (rule.imageInput !== undefined) {
			resolved.imageInput = rule.imageInput;
		}
		if (typeof rule.maxInputTokens === 'number' && rule.maxInputTokens > 0) {
			resolved.maxInputTokens = rule.maxInputTokens;
		}
		if (typeof rule.maxOutputTokens === 'number' && rule.maxOutputTokens > 0) {
			resolved.maxOutputTokens = rule.maxOutputTokens;
		}
		if (rule.hide !== undefined) {
			resolved.hide = rule.hide;
		}
	}

	return resolved;
}

/** Full rule chain: built-in defaults first, user rules last so they override. */
export function ruleChain(userRules: readonly ModelRule[]): readonly ModelRule[] {
	return [...DEFAULT_MODEL_RULES, ...userRules];
}

/** Why a model was withheld, or `undefined` when it is offered. */
export type HideReason = 'rule' | 'unknown';

/**
 * Decides whether a model is offered, and why not.
 *
 * The reason matters for diagnostics: "no models" caused by a `hide` rule and
 * "no models" caused by `hideUnknownModels` need completely different fixes,
 * and the difference is invisible from the outside.
 */
export function hideReason(caps: ResolvedCapabilities, hideUnknown: boolean): HideReason | undefined {
	if (caps.hide) {
		return 'rule';
	}
	if (hideUnknown && !caps.matched) {
		return 'unknown';
	}
	return undefined;
}

/** An explicit `hide` always wins; `hideUnknownModels` only affects unmatched models. */
export function shouldHide(caps: ResolvedCapabilities, hideUnknown: boolean): boolean {
	return hideReason(caps, hideUnknown) !== undefined;
}
