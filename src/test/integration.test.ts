import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockProvider, type MockProvider } from './mockProvider';
import { ChatCompletionAccumulator, SseDecoder, StreamEvent, eventsFromCompletion } from '../provider/stream';
import { HttpError, parseRetryAfter, withRetry } from '../util/backoff';
import { resolveCapabilities, ruleChain, shouldHide } from '../config/modelRules';

/**
 * Mirrors `WorkspaceKeysChatProvider.consume`, minus the `vscode` types.
 *
 * Keeping the loop in step with the real one is what makes these tests
 * meaningful: they run against real sockets, a real `fetch` and a real
 * `ReadableStream`, so genuine chunk boundaries are exercised.
 */
async function consume(response: Response): Promise<StreamEvent[]> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const sse = new SseDecoder();
	const accumulator = new ChatCompletionAccumulator();
	const events: StreamEvent[] = [];

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		for (const payload of sse.push(decoder.decode(value, { stream: true }))) {
			events.push(...accumulator.handle(payload));
		}
	}
	for (const payload of sse.flush()) {
		events.push(...accumulator.handle(payload));
	}
	events.push(...accumulator.finish());
	return events;
}

describe('against a live OpenAI-compatible endpoint', () => {
	let mock: MockProvider;

	before(async () => {
		mock = await startMockProvider();
	});
	after(async () => {
		await mock.close();
	});

	test('discovers models and filters them through the rule chain', async () => {
		const response = await fetch(`${mock.baseUrl}/models`, { headers: { Authorization: 'Bearer test-key' } });
		assert.equal(response.status, 200);

		const body = (await response.json()) as { data: Array<{ id: string }> };
		const ids = body.data.map((entry) => entry.id);
		assert.deepEqual(ids, ['gpt-4o-mini', 'text-embedding-3-small', 'internal-secret-model']);

		const rules = ruleChain([]);
		const visible = ids.filter((id) => !shouldHide(resolveCapabilities(id, rules), true));

		// The embedding model is hidden by a built-in rule, the unknown one by
		// hideUnknownModels.
		assert.deepEqual(visible, ['gpt-4o-mini']);
	});

	test('an unknown model becomes visible once a user rule matches it', () => {
		const rules = ruleChain([{ match: 'internal-*', toolCalling: true, maxInputTokens: 32000 }]);
		const caps = resolveCapabilities('internal-secret-model', rules);
		assert.equal(shouldHide(caps, true), false);
		assert.equal(caps.toolCalling, true);
	});

	test('streams text and a fragmented tool call over real sockets', async () => {
		const response = await fetch(`${mock.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
			body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true }),
		});
		assert.equal(response.status, 200);
		assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

		const events = await consume(response);
		const text = events
			.filter((event) => event.type === 'text')
			.map((event) => (event.type === 'text' ? event.value : ''))
			.join('');
		assert.equal(text, 'Reading the file');

		const calls = events.filter((event) => event.type === 'toolCall');
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], {
			type: 'toolCall',
			callId: 'call_42',
			name: 'read_file',
			input: { path: 'src/a.ts', deep: { n: 1 } },
		});
	});

	test('forwards the key as a bearer token and never in the body', async () => {
		const before = mock.requests.length;
		await fetch(`${mock.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-secret-value' },
			body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
		}).then(consume);

		const recorded = mock.requests[before];
		assert.equal(recorded.authorization, 'Bearer sk-secret-value');
		assert.ok(!JSON.stringify(recorded.body).includes('sk-secret-value'));
	});
});

describe('transient failures', () => {
	let mock: MockProvider;

	before(async () => {
		mock = await startMockProvider({ rateLimitTimes: 2 });
	});
	after(async () => {
		await mock.close();
	});

	test('retries through 429 responses and then streams normally', async () => {
		let attempts = 0;
		const response = await withRetry(
			async () => {
				attempts++;
				const result = await fetch(`${mock.baseUrl}/chat/completions`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k' },
					body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
				});
				if (!result.ok) {
					throw new HttpError(result.status, await result.text(), parseRetryAfter(result.headers.get('retry-after')));
				}
				return result;
			},
			{ maxAttempts: 4, sleep: async () => undefined },
		);

		assert.equal(attempts, 3);
		const events = await consume(response);
		assert.ok(events.some((event) => event.type === 'toolCall'));
	});
});

describe('a provider that ignores stream: true', () => {
	let mock: MockProvider;

	before(async () => {
		mock = await startMockProvider({ nonStreaming: true });
	});
	after(async () => {
		await mock.close();
	});

	test('falls back to parsing the whole body', async () => {
		const response = await fetch(`${mock.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k' },
			body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
		});

		assert.ok(!(response.headers.get('content-type') ?? '').includes('text/event-stream'));
		assert.deepEqual(eventsFromCompletion(await response.json()), [{ type: 'text', value: 'non-streamed answer' }]);
	});
});
