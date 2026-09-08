/**
 * Types shared across the extension. This file deliberately does not import
 * `vscode` so that the pure logic built on top of it stays unit-testable with
 * plain `node --test`.
 */

export interface ProviderConfig {
	id: string;
	label?: string;
	baseUrl: string;
	apiKey?: string;
	models?: string[];
	headers?: Record<string, string>;
}

export interface ModelRule {
	match: string;
	toolCalling?: boolean | number;
	imageInput?: boolean;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	hide?: boolean;
}

/** The capability set a rule chain resolves to, before it becomes a `LanguageModelChatInformation`. */
export interface ResolvedCapabilities {
	toolCalling: boolean | number;
	imageInput: boolean;
	maxInputTokens: number;
	maxOutputTokens: number;
	hide: boolean;
	/** False when no rule matched and the fallback was used. */
	matched: boolean;
}

export type KeySource = 'secret' | 'env' | 'plaintext';

export interface ResolvedKey {
	key: string;
	source: KeySource;
	/** Never set — declared so the union can be inspected without narrowing first. */
	reason?: undefined;
	envNames?: undefined;
	withheld?: undefined;
}

/**
 * A stored key that was withheld because the workspace path was reused.
 *
 * Carries what a notification needs to explain itself and what an action needs
 * to act — the SecretStorage name, so the key can be deleted or re-confirmed
 * without recomputing it.
 */
export interface WithheldKey {
	providerId: string;
	/** SecretStorage name of the withheld entry. */
	secretName: string;
	/** Recognisable short form of the workspace it was stored for. */
	label: string;
	/** When it was stored, epoch ms. */
	storedAt: number;
}

/**
 * Why no key was handed out.
 *
 * - `absent` — nothing stored and nothing configured.
 * - `missing-env` — a `${env:...}` reference names variables that are not set.
 * - `workspace-env-blocked` — the reference sits in workspace settings, which
 *   must not be able to read the user's environment (see `KeyResolver.resolve`).
 * - `withheld` — a stored key exists but the workspace path was recycled; the
 *   `withheld` field carries what a prompt needs.
 */
export type KeyFailureReason = 'absent' | 'missing-env' | 'workspace-env-blocked' | 'withheld';

export interface KeyResolutionFailure {
	key?: undefined;
	reason: KeyFailureReason;
	/** Names of the `${env:...}` variables the reason refers to; empty otherwise. */
	envNames: string[];
	/** Set exactly when `reason` is `withheld` — see `WithheldKey`. */
	withheld?: WithheldKey;
}

export type KeyResolution = ResolvedKey | KeyResolutionFailure;

export function isResolvedKey(r: KeyResolution): r is ResolvedKey {
	return typeof (r as ResolvedKey).key === 'string' && (r as ResolvedKey).key.length > 0;
}
