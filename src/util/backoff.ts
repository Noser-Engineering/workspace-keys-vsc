/** Minimal cancellation shape, so this module stays free of a `vscode` import. */
export interface Cancellable {
	readonly isCancellationRequested: boolean;
}

export interface RetryOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	token?: Cancellable;
	sleep?: (ms: number) => Promise<void>;
	onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly body: string,
		readonly retryAfterSeconds?: number,
	) {
		super(`HTTP ${status}: ${body.slice(0, 500)}`);
		this.name = 'HttpError';
	}
}

/** 429 and 5xx are transient; every other 4xx is a client error and is not retried. */
export function isRetryable(error: unknown): boolean {
	if (error instanceof HttpError) {
		return error.status === 429 || error.status >= 500;
	}
	// Network-level failures (DNS, reset, TLS) surface as TypeError from fetch.
	return error instanceof TypeError;
}

export function delayFor(attempt: number, base: number, max: number, retryAfterSeconds?: number): number {
	if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
		return Math.min(retryAfterSeconds * 1000, max);
	}
	const exponential = Math.min(base * 2 ** (attempt - 1), max);
	// Full jitter, to avoid several windows retrying against the same endpoint in lockstep.
	return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

/** Parses `Retry-After`, which is either delta-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
	if (!header) {
		return undefined;
	}
	const seconds = Number(header);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds);
	}
	const asDate = Date.parse(header);
	if (Number.isFinite(asDate)) {
		return Math.max(0, (asDate - now) / 1000);
	}
	return undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
	const maxAttempts = options.maxAttempts ?? 3;
	const baseDelayMs = options.baseDelayMs ?? 500;
	const maxDelayMs = options.maxDelayMs ?? 20_000;
	const sleep = options.sleep ?? defaultSleep;

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (options.token?.isCancellationRequested) {
			throw new CancelledError();
		}
		try {
			return await operation(attempt);
		} catch (error) {
			lastError = error;
			if (error instanceof CancelledError || attempt === maxAttempts || !isRetryable(error)) {
				throw error;
			}
			const retryAfter = error instanceof HttpError ? error.retryAfterSeconds : undefined;
			const delay = delayFor(attempt, baseDelayMs, maxDelayMs, retryAfter);
			options.onRetry?.(attempt, delay, error instanceof Error ? error.message : String(error));
			await sleep(delay);
		}
	}
	throw lastError;
}

export class CancelledError extends Error {
	constructor() {
		super('Request cancelled');
		this.name = 'CancelledError';
	}
}
