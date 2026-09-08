/**
 * Validation and normalisation of a provider base URL, separated from the
 * configuration and UI layers so it can be unit-tested with plain `node --test`.
 *
 * The rules exist because a base URL decides where prompts and the API key go:
 *
 * - **HTTPS only.** A bearer token and the full prompt travel in the request, so
 *   cleartext transport is not an option a user can consent to by accident.
 * - **Loopback HTTP only as a development opt-in.** Mock providers are the one
 *   legitimate cleartext case, and only from a user-scoped setting — a workspace
 *   must not be able to turn cleartext back on.
 * - **No credentials and no query.** A userinfo component and a `?api-key=…`
 *   parameter would both put a secret into settings, logs and error messages.
 */

export type BaseUrlProblem = 'empty' | 'unparsable' | 'unsupported-scheme' | 'insecure' | 'credentials' | 'query';

export interface BaseUrlOptions {
	/** User-scoped development opt-in; permits `http:` on loopback hosts only. */
	allowInsecureLoopback?: boolean;
}

export type BaseUrlResult = { ok: true; baseUrl: string; origin: string } | { ok: false; problem: BaseUrlProblem; message: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * True for the hosts a cleartext development endpoint may use. The whole 127/8
 * range counts, but only as a literal address: `127.example.com` is a name that
 * resolves wherever its owner points it.
 */
export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return LOOPBACK_HOSTS.has(host) || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Checks a base URL and returns it without trailing slashes, or the reason it
 * was rejected. The message is written to be shown to the user as-is.
 */
export function validateBaseUrl(value: string, options: BaseUrlOptions = {}): BaseUrlResult {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return { ok: false, problem: 'empty', message: 'Enter the base URL of an OpenAI-compatible API.' };
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { ok: false, problem: 'unparsable', message: 'This is not a valid URL.' };
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		return { ok: false, problem: 'unsupported-scheme', message: 'Only https:// URLs are supported.' };
	}
	if (url.username.length > 0 || url.password.length > 0) {
		return {
			ok: false,
			problem: 'credentials',
			message: 'Remove the credentials from the URL. The API key is stored separately in SecretStorage.',
		};
	}
	if (url.search.length > 0 || url.hash.length > 0) {
		return {
			ok: false,
			problem: 'query',
			message: 'A base URL must not carry a query string or fragment.',
		};
	}
	if (url.protocol === 'http:') {
		if (!isLoopbackHost(url.hostname)) {
			return {
				ok: false,
				problem: 'insecure',
				message: 'Use https://. Cleartext http:// would send your API key and prompts unencrypted.',
			};
		}
		if (!options.allowInsecureLoopback) {
			return {
				ok: false,
				problem: 'insecure',
				message:
					'Cleartext http:// to a local endpoint requires the development setting "Allow Insecure Loopback" in your user settings.',
			};
		}
	}

	return { ok: true, baseUrl: normalise(url), origin: url.origin };
}

function normalise(url: URL): string {
	const path = url.pathname.replace(/\/+$/, '');
	return `${url.origin}${path}`;
}
