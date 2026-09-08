/**
 * The pure endpoint-approval decision, separated from the state and UI in
 * `BaseUrlConsent` so it can be unit-tested with plain `node --test`.
 */

import type { ProviderOrigin } from '../config/workspaceConfig';

/**
 * Whether requests may be sent to `baseUrl` without asking.
 *
 * - `providerOrigin === 'user'`: the URL was typed into the user's own settings,
 *   or entered in the setup dialog, which shows the full URL before anything is
 *   sent. Asking them to confirm what they just wrote is theatre, not security.
 * - Everything a workspace declares needs an approved origin — loopback
 *   included: `127.0.0.1` is where a malicious process would listen, and a
 *   cloned repository choosing the URL is exactly the case the gate exists for.
 */
export function isEndpointApproved(baseUrl: string, providerOrigin: ProviderOrigin, approvedOrigins: readonly string[]): boolean {
	const origin = originOf(baseUrl);
	if (!origin) {
		return false;
	}
	return providerOrigin === 'user' || approvedOrigins.includes(origin);
}

/** Approval is per origin, not per full URL, so a path change does not re-ask. */
export function originOf(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).origin;
	} catch {
		return undefined;
	}
}
