import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChatCompletionAccumulator, SseDecoder, StreamEvent, StreamProtocolError, eventsFromCompletion } from '../provider/stream';

/** Feeds `text` through the decoder in fixed-size slices to simulate arbitrary chunk boundaries. */
function drive(text: string, chunkSize: number): StreamEvent[] {
	const decoder = new SseDecoder();
	const accumulator = new ChatCompletionAccumulator();
	const events: StreamEvent[] = [];

	for (let offset = 0; offset < text.length; offset += chunkSize) {
		for (const payload of decoder.push(text.slice(offset, offset + chunkSize))) {
			events.push(...accumulator.handle(payload));
		}
	}
	for (const payload of decoder.flush()) {
		events.push(...accumulator.handle(payload));
	}
	events.push(...accumulator.finish());
	return events;
}

function textOf(events: StreamEvent[]): string {
	return events
		.filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
		.map((event) => event.value)
		.join('');
}

const chunk = (delta: object, finish: string | null = null) =>
	`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;

describe('SseDecoder', () => {
	test('reassembles text across every chunk boundary', () => {
		const stream = chunk({ content: 'Hello' }) + chunk({ content: ', world' }) + chunk({}, 'stop') + 'data: [DONE]\n\n';

		for (const size of [1, 2, 3, 7, 13, 64, 4096]) {
			assert.equal(textOf(drive(stream, size)), 'Hello, world', `chunk size ${size}`);
		}
	});

	test('handles CRLF line endings', () => {
		const stream = chunk({ content: 'ok' }).replace(/\n/g, '\r\n');
		assert.equal(textOf(drive(stream, 3)), 'ok');
	});

	test('ignores comments and unknown fields', () => {
		const stream = `: keep-alive\nevent: message\nid: 1\n${chunk({ content: 'x' })}`;
		assert.equal(textOf(drive(stream, 5)), 'x');
	});

	test('joins multiple data lines of one event', () => {
		const payload = JSON.stringify({ choices: [{ delta: { content: 'multi' } }] });
		const half = Math.floor(payload.length / 2);
		const stream = `data: ${payload.slice(0, half)}\ndata: ${payload.slice(half)}\n\n`;

		// The SSE spec joins data lines with "\n"; a JSON payload split this way
		// only parses because JSON tolerates the newline between tokens.
		const decoder = new SseDecoder();
		const payloads = [...decoder.push(stream), ...decoder.flush()];
		assert.equal(payloads.length, 1);
		assert.equal(payloads[0], `${payload.slice(0, half)}\n${payload.slice(half)}`);
	});

	test('flushes an event that is not terminated by a blank line', () => {
		const decoder = new SseDecoder();
		decoder.push('data: {"choices":[]}');
		assert.deepEqual(decoder.flush(), ['{"choices":[]}']);
	});
});

describe('ChatCompletionAccumulator', () => {
	test('emits a tool call only once its arguments are complete', () => {
		const stream =
			chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] }) +
			chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }) +
			chunk({ tool_calls: [{ index: 0, function: { arguments: '"src/a' } }] }) +
			chunk({ tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] }) +
			chunk({}, 'tool_calls') +
			'data: [DONE]\n\n';

		for (const size of [1, 5, 40, 4096]) {
			const events = drive(stream, size);
			const calls = events.filter((event) => event.type === 'toolCall');
			assert.equal(calls.length, 1, `chunk size ${size}`);
			assert.deepEqual(calls[0], {
				type: 'toolCall',
				callId: 'call_1',
				name: 'read_file',
				input: { path: 'src/a.ts' },
			});
		}
	});

	test('keeps parallel tool calls separate by index', () => {
		const stream =
			chunk({
				tool_calls: [
					{ index: 0, id: 'a', function: { name: 'one', arguments: '{"x":' } },
					{ index: 1, id: 'b', function: { name: 'two', arguments: '{"y":' } },
				],
			}) +
			chunk({ tool_calls: [{ index: 1, function: { arguments: '2}' } }] }) +
			chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }) +
			chunk({}, 'tool_calls');

		const calls = drive(stream, 9).filter((event) => event.type === 'toolCall');
		assert.deepEqual(calls, [
			{ type: 'toolCall', callId: 'a', name: 'one', input: { x: 1 } },
			{ type: 'toolCall', callId: 'b', name: 'two', input: { y: 2 } },
		]);
	});

	test('reassembles a function name that arrives in fragments', () => {
		const stream =
			chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'read_', arguments: '' } }] }) +
			chunk({ tool_calls: [{ index: 0, function: { name: 'file', arguments: '{}' } }] }) +
			chunk({}, 'tool_calls');

		const calls = drive(stream, 4096).filter((event) => event.type === 'toolCall');
		assert.equal(calls.length, 1);
		assert.equal(calls[0].type === 'toolCall' && calls[0].name, 'read_file');
	});

	test('does not emit a tool call twice when finish_reason and EOF both flush', () => {
		const accumulator = new ChatCompletionAccumulator();
		const first = accumulator.handle(
			JSON.stringify({
				choices: [
					{
						delta: { tool_calls: [{ index: 0, id: 'z', function: { name: 't', arguments: '{}' } }] },
						finish_reason: 'tool_calls',
					},
				],
			}),
		);
		assert.equal(first.filter((event) => event.type === 'toolCall').length, 1);
		assert.deepEqual(accumulator.finish(), []);
	});

	test('defaults a missing index to the array position', () => {
		const stream = chunk({ tool_calls: [{ id: 'solo', function: { name: 'go', arguments: '{"a":true}' } }] }) + chunk({}, 'tool_calls');
		const calls = drive(stream, 4096).filter((event) => event.type === 'toolCall');
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].type === 'toolCall' && calls[0].input, { a: true });
	});

	test('accepts array-shaped content', () => {
		const stream = chunk({
			content: [
				{ type: 'text', text: 'from ' },
				{ type: 'text', text: 'parts' },
			],
		});
		assert.equal(textOf(drive(stream, 6)), 'from parts');
	});

	test('ignores [DONE] and blank payloads', () => {
		const accumulator = new ChatCompletionAccumulator();
		assert.deepEqual(accumulator.handle('[DONE]'), []);
		assert.deepEqual(accumulator.handle('   '), []);
	});

	test('surfaces a provider error object', () => {
		const accumulator = new ChatCompletionAccumulator();
		assert.throws(
			() => accumulator.handle(JSON.stringify({ error: { message: 'rate limited' } })),
			(error: Error) => error instanceof StreamProtocolError && error.message.includes('rate limited'),
		);
	});

	test('rejects malformed payloads and non-JSON tool arguments', () => {
		assert.throws(() => new ChatCompletionAccumulator().handle('{not json'), StreamProtocolError);

		const accumulator = new ChatCompletionAccumulator();
		accumulator.handle(
			JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'q', function: { name: 'f', arguments: '{"a"' } }] } }] }),
		);
		assert.throws(() => accumulator.finish(), StreamProtocolError);
	});

	test('treats empty tool arguments as an empty object', () => {
		const stream =
			chunk({ tool_calls: [{ index: 0, id: 'e', function: { name: 'noargs', arguments: '' } }] }) + chunk({}, 'tool_calls');
		const calls = drive(stream, 4096).filter((event) => event.type === 'toolCall');
		assert.deepEqual(calls[0].type === 'toolCall' && calls[0].input, {});
	});

	// An early finish_reason (multiple choices, or a gateway that sends it ahead
	// of a trailing tool call) must not be treated as the end of the stream, or
	// every tool call arriving afterwards is silently dropped.
	test('a tool call arriving after another choice already finished is still emitted', () => {
		const accumulator = new ChatCompletionAccumulator();
		const events: StreamEvent[] = [];

		events.push(...accumulator.handle(JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] })));
		events.push(
			...accumulator.handle(
				JSON.stringify({
					choices: [{ index: 1, delta: { tool_calls: [{ index: 3, id: 'late', function: { name: 'go', arguments: '{}' } }] } }],
				}),
			),
		);
		events.push(...accumulator.finish());

		assert.deepEqual(events, [
			{ type: 'text', value: 'hi' },
			{ type: 'toolCall', callId: 'late', name: 'go', input: {} },
		]);
	});

	test('an emitted tool call is not re-emitted by a second finish_reason or EOF', () => {
		const accumulator = new ChatCompletionAccumulator();
		const first = accumulator.handle(
			JSON.stringify({
				choices: [
					{
						delta: { tool_calls: [{ index: 0, id: 'once', function: { name: 'f', arguments: '{}' } }] },
						finish_reason: 'tool_calls',
					},
				],
			}),
		);
		assert.equal(first.filter((event) => event.type === 'toolCall').length, 1);
		assert.deepEqual(accumulator.handle(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })), []);
		assert.deepEqual(accumulator.finish(), []);
	});

	test('a stray fragment for an already emitted index neither throws nor re-emits', () => {
		const accumulator = new ChatCompletionAccumulator();
		accumulator.handle(
			JSON.stringify({
				choices: [
					{
						delta: { tool_calls: [{ index: 0, id: 'd', function: { name: 'f', arguments: '{}' } }] },
						finish_reason: 'tool_calls',
					},
				],
			}),
		);
		assert.deepEqual(
			accumulator.handle(
				JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'garbage' } }] } }] }),
			),
			[],
		);
		assert.deepEqual(accumulator.finish(), []);
	});
});

describe('eventsFromCompletion', () => {
	test('converts a non-streamed body', () => {
		const events = eventsFromCompletion({
			choices: [
				{
					message: {
						content: 'done',
						tool_calls: [{ index: 0, id: 'n1', function: { name: 'search', arguments: '{"q":"x"}' } }],
					},
					finish_reason: 'tool_calls',
				},
			],
		});
		assert.deepEqual(events, [
			{ type: 'text', value: 'done' },
			{ type: 'toolCall', callId: 'n1', name: 'search', input: { q: 'x' } },
		]);
	});
});
