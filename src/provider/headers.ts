import type { ProviderConfig } from '../types';

/**
 * Request header assembly, free of `vscode` so it can be unit-tested.
 *
 * `headers` in a provider entry is arbitrary user input. It is applied *before*
 * the protocol headers and the credential, and header names that decide
 * authentication, routing or framing are dropped outright — otherwise a
 * configuration could replace the resolved API key with one of its own, or
 * point the request at a different host than the one that was approved.
 */
export const RESERVED_HEADERS = new Set([
	'authorization',
	'proxy-authorization',
	'cookie',
	'set-cookie',
	'host',
	'content-length',
	'content-type',
	'accept',
	'connection',
	'transfer-encoding',
	'upgrade',
	'te',
	'trailer',
]);

export interface SanitizedHeaders {
	headers: Record<string, string>;
	/** Names that were dropped, so the caller can warn about them once. */
	rejected: string[];
}

/** Drops reserved and syntactically invalid header names from user input. */
export function sanitizeCustomHeaders(headers: Record<string, string> | undefined): SanitizedHeaders {
	const safe: Record<string, string> = {};
	const rejected: string[] = [];
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (RESERVED_HEADERS.has(name.trim().toLowerCase()) || !isValidHeaderName(name) || typeof value !== 'string') {
			rejected.push(name);
			continue;
		}
		safe[name] = value;
	}
	return { headers: safe, rejected };
}

/**
 * Builds the outgoing header map. Order is the security property: custom
 * headers first, then the protocol headers and the credential, then the
 * caller's own overrides, which are internal to this extension.
 */
export function buildRequestHeaders(
	provider: ProviderConfig,
	apiKey: string,
	extra?: Record<string, string>,
): { headers: Record<string, string>; rejected: string[] } {
	const { headers: custom, rejected } = sanitizeCustomHeaders(provider.headers);
	return {
		headers: {
			...custom,
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
			Authorization: `Bearer ${apiKey}`,
			...extra,
		},
		rejected,
	};
}

/** RFC 7230 token characters; anything else cannot be a header name. */
function isValidHeaderName(name: string): boolean {
	return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}
