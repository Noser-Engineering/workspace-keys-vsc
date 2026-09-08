import * as vscode from 'vscode';
import type { ProviderConfig } from '../types';
import { HttpError, parseRetryAfter } from '../util/backoff';
import { log, scrubSecret, truncateBody } from '../util/log';
import { buildRequestHeaders } from './headers';

const warnedAboutHeaders = new Set<string>();

/**
 * Assembles the outgoing headers. The rules live in `headers.ts`; this only adds
 * the one-time warning, so a dropped header is visible without spamming the log
 * on every request.
 */
export function buildHeaders(provider: ProviderConfig, apiKey: string, extra?: Record<string, string>): Record<string, string> {
	const { headers, rejected } = buildRequestHeaders(provider, apiKey, extra);
	if (rejected.length > 0 && !warnedAboutHeaders.has(provider.id)) {
		warnedAboutHeaders.add(provider.id);
		log().warn(
			`Provider "${provider.id}": ignoring the configured header(s) ${rejected.join(', ')}. ` +
				'Authentication, routing and framing headers cannot be overridden.',
		);
	}
	return headers;
}

export function endpoint(provider: ProviderConfig, path: string): string {
	return `${provider.baseUrl}/${path.replace(/^\/+/, '')}`;
}

/** Reads an error body defensively; a failure to read must not mask the status. */
export async function toHttpError(response: Response, apiKey: string | undefined): Promise<HttpError> {
	let body = '';
	try {
		body = await response.text();
	} catch {
		body = '<unreadable response body>';
	}
	return new HttpError(response.status, truncateBody(scrubSecret(body, apiKey)), parseRetryAfter(response.headers.get('retry-after')));
}

/** Bridges a `CancellationToken` to an `AbortSignal`; dispose to release the listener. */
export function abortOn(token: vscode.CancellationToken): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	}
	const registration = token.onCancellationRequested(() => controller.abort());
	return { signal: controller.signal, dispose: () => registration.dispose() };
}
