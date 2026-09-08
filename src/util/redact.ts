/**
 * Redaction primitives, free of `vscode` so they can be unit-tested.
 *
 * The header rule is an allowlist rather than a blocklist: `headers` in a
 * provider entry is arbitrary user input, so a credential can arrive under any
 * name — `X-Auth-Token` as easily as `Authorization`. Only header names known
 * to be uninteresting are logged with their value.
 */

/** Header names whose value carries no secret and is worth seeing in a log. */
export const LOGGABLE_HEADERS = new Set(['accept', 'content-type', 'accept-encoding', 'user-agent']);

/** Longest provider error body that is logged or surfaced verbatim. */
export const MAX_BODY_LENGTH = 500;

/** Header map safe to log: everything not explicitly loggable is replaced. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
	const safe: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		safe[name] = LOGGABLE_HEADERS.has(name.toLowerCase()) ? value : '<redacted>';
	}
	return safe;
}

/**
 * Removes a key from text before it is logged or surfaced in an error.
 * Providers echo the sent key back in some 401 bodies. Applies to keys of any
 * length: a short key is still a key.
 */
export function scrubSecret(text: string, secret: string | undefined): string {
	if (!secret || secret.length === 0) {
		return text;
	}
	return text.split(secret).join('<redacted>');
}

/**
 * Caps a remote response body. Provider errors end up in the log and in
 * user-facing messages, and an unbounded body can carry anything the endpoint
 * decides to echo back.
 */
export function truncateBody(text: string, max: number = MAX_BODY_LENGTH): string {
	return text.length <= max ? text : `${text.slice(0, max)}… <truncated>`;
}
