import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CancelledError, HttpError, delayFor, isRetryable, parseRetryAfter, withRetry } from '../util/backoff';

const noSleep = async () => undefined;

describe('isRetryable', () => {
	test('retries 429 and 5xx', () => {
		assert.equal(isRetryable(new HttpError(429, '')), true);
		assert.equal(isRetryable(new HttpError(500, '')), true);
		assert.equal(isRetryable(new HttpError(503, '')), true);
	});

	test('does not retry other client errors', () => {
		for (const status of [400, 401, 403, 404, 422]) {
			assert.equal(isRetryable(new HttpError(status, '')), false, String(status));
		}
	});

	test('retries network-level failures', () => {
		assert.equal(isRetryable(new TypeError('fetch failed')), true);
		assert.equal(isRetryable(new Error('something else')), false);
	});
});

describe('parseRetryAfter', () => {
	test('reads delta-seconds', () => {
		assert.equal(parseRetryAfter('30'), 30);
	});

	test('reads an HTTP date relative to now', () => {
		const now = Date.parse('2026-01-01T00:00:00Z');
		assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now), 10);
	});

	test('never returns a negative delay', () => {
		const now = Date.parse('2026-01-01T00:00:00Z');
		assert.equal(parseRetryAfter('Thu, 01 Jan 2025 00:00:00 GMT', now), 0);
		assert.equal(parseRetryAfter('-5'), 0);
	});

	test('returns undefined for a missing or unparseable header', () => {
		assert.equal(parseRetryAfter(null), undefined);
		assert.equal(parseRetryAfter('soon'), undefined);
	});
});

describe('delayFor', () => {
	test('honours Retry-After over the exponential schedule', () => {
		assert.equal(delayFor(1, 500, 20_000, 3), 3000);
	});

	test('caps Retry-After at the maximum delay', () => {
		assert.equal(delayFor(1, 500, 20_000, 600), 20_000);
	});

	test('grows exponentially and stays within the jitter window', () => {
		for (const attempt of [1, 2, 3, 4]) {
			const expected = Math.min(500 * 2 ** (attempt - 1), 20_000);
			const actual = delayFor(attempt, 500, 20_000);
			assert.ok(actual >= expected * 0.5 - 1 && actual <= expected, `attempt ${attempt}: ${actual}`);
		}
	});
});

describe('withRetry', () => {
	test('returns the first successful result', async () => {
		let calls = 0;
		const result = await withRetry(
			async () => {
				calls++;
				return 'ok';
			},
			{ sleep: noSleep },
		);
		assert.equal(result, 'ok');
		assert.equal(calls, 1);
	});

	test('retries a transient failure and then succeeds', async () => {
		let calls = 0;
		const result = await withRetry(
			async () => {
				calls++;
				if (calls < 3) {
					throw new HttpError(429, 'slow down', 0);
				}
				return 'recovered';
			},
			{ sleep: noSleep },
		);
		assert.equal(result, 'recovered');
		assert.equal(calls, 3);
	});

	test('gives up after maxAttempts and rethrows the last error', async () => {
		let calls = 0;
		await assert.rejects(
			withRetry(
				async () => {
					calls++;
					throw new HttpError(500, 'boom');
				},
				{ sleep: noSleep, maxAttempts: 3 },
			),
			(error: Error) => error instanceof HttpError && error.status === 500,
		);
		assert.equal(calls, 3);
	});

	test('does not retry a client error', async () => {
		let calls = 0;
		await assert.rejects(
			withRetry(
				async () => {
					calls++;
					throw new HttpError(401, 'unauthorized');
				},
				{ sleep: noSleep },
			),
			HttpError,
		);
		assert.equal(calls, 1);
	});

	test('stops when the token is cancelled between attempts', async () => {
		let calls = 0;
		const token = { isCancellationRequested: false };
		await assert.rejects(
			withRetry(
				async () => {
					calls++;
					token.isCancellationRequested = true;
					throw new HttpError(500, 'boom');
				},
				{ sleep: noSleep, token, maxAttempts: 5 },
			),
			CancelledError,
		);
		assert.equal(calls, 1);
	});

	test('reports each retry with its delay', async () => {
		const seen: number[] = [];
		await assert.rejects(
			withRetry(
				async () => {
					throw new HttpError(503, 'unavailable', 1);
				},
				{ sleep: noSleep, maxAttempts: 3, onRetry: (_attempt, delay) => seen.push(delay) },
			),
			HttpError,
		);
		assert.deepEqual(seen, [1000, 1000]);
	});
});
