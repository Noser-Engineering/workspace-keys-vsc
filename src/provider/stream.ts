/**
 * SSE decoding and chat-completion accumulation.
 *
 * Kept free of any `vscode` import: the provider maps these plain events onto
 * `LanguageModelTextPart` / `LanguageModelToolCallPart`, which lets the parser
 * — the part most likely to break against a real provider — be unit-tested.
 */

export type StreamEvent = { type: 'text'; value: string } | { type: 'toolCall'; callId: string; name: string; input: object };

export class StreamProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StreamProtocolError';
	}
}

/**
 * Incremental `text/event-stream` decoder.
 *
 * Chunk boundaries fall anywhere, including mid-line and mid-`\r\n`, so the
 * trailing partial line is always carried over to the next `push`.
 */
export class SseDecoder {
	private buffer = '';
	private dataLines: string[] = [];

	/** Returns the payload of every event completed by this chunk. */
	push(chunk: string): string[] {
		this.buffer += chunk;
		const payloads: string[] = [];

		let newline: number;
		while ((newline = this.buffer.indexOf('\n')) !== -1) {
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith('\r')) {
				line = line.slice(0, -1);
			}

			if (line === '') {
				const payload = this.takeEvent();
				if (payload !== undefined) {
					payloads.push(payload);
				}
				continue;
			}
			if (line.startsWith(':')) {
				// Comment / keep-alive.
				continue;
			}
			if (line.startsWith('data:')) {
				const value = line.slice('data:'.length);
				this.dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
			}
			// `event:`, `id:` and `retry:` carry nothing we act on.
		}

		return payloads;
	}

	/** Flushes an event that was not terminated by a blank line before EOF. */
	flush(): string[] {
		const payloads: string[] = [];
		if (this.buffer.length > 0) {
			const remainder = this.buffer;
			this.buffer = '';
			payloads.push(...this.push(`${remainder}\n`));
		}
		const payload = this.takeEvent();
		if (payload !== undefined) {
			payloads.push(payload);
		}
		return payloads;
	}

	private takeEvent(): string | undefined {
		if (this.dataLines.length === 0) {
			return undefined;
		}
		const payload = this.dataLines.join('\n');
		this.dataLines = [];
		return payload;
	}
}

interface PendingToolCall {
	id: string;
	name: string;
	args: string;
}

/**
 * Turns decoded SSE payloads into {@link StreamEvent}s.
 *
 * Text is emitted as it arrives. Tool calls are not: OpenAI sends `id` and
 * `function.name` in the first delta and streams `function.arguments` as a
 * character-level fragment sequence, so a call is only complete once the stream
 * says so. Emitting earlier truncates the arguments.
 */
export class ChatCompletionAccumulator {
	private readonly toolCalls = new Map<number, PendingToolCall>();
	/**
	 * Indexes already handed out. Tracked per index rather than as one flag:
	 * with `n > 1`, or on gateways that send `finish_reason` early, tool calls
	 * can still arrive after the first flush and must not be dropped — while a
	 * second `finish()` for the same index must stay silent.
	 */
	private readonly emitted = new Set<number>();

	/** @param payload raw SSE data payload, `[DONE]` included */
	handle(payload: string): StreamEvent[] {
		const trimmed = payload.trim();
		if (trimmed === '' || trimmed === '[DONE]') {
			return [];
		}

		let parsed: any;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new StreamProtocolError(`Malformed SSE payload: ${trimmed.slice(0, 200)}`);
		}

		if (parsed?.error) {
			const message = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message ?? JSON.stringify(parsed.error));
			throw new StreamProtocolError(`Provider reported an error: ${message}`);
		}

		const events: StreamEvent[] = [];
		for (const choice of parsed?.choices ?? []) {
			const delta = choice?.delta ?? choice?.message;
			if (delta) {
				const text = extractText(delta.content);
				if (text) {
					events.push({ type: 'text', value: text });
				}
				this.accumulateToolCalls(delta.tool_calls);
			}
			if (choice?.finish_reason) {
				events.push(...this.finish());
			}
		}
		return events;
	}

	/** Emits every buffered tool call not yet emitted. Idempotent per index, so a late `finish_reason` and EOF cannot double-emit. */
	finish(): StreamEvent[] {
		const events: StreamEvent[] = [];
		for (const index of [...this.toolCalls.keys()].sort((a, b) => a - b)) {
			if (this.emitted.has(index)) {
				continue;
			}
			const call = this.toolCalls.get(index)!;
			if (!call.name) {
				throw new StreamProtocolError(`Tool call at index ${index} arrived without a function name`);
			}
			const input = parseToolArguments(call.name, call.args);
			this.emitted.add(index);
			events.push({
				type: 'toolCall',
				callId: call.id || `call_${index}`,
				name: call.name,
				input,
			});
		}
		// Emitted entries stay in `toolCalls` on purpose: a stray late fragment
		// for a flushed index then lands on the completed entry and is ignored,
		// instead of creating a nameless one that a final `finish()` trips over.
		return events;
	}

	private accumulateToolCalls(deltas: unknown): void {
		if (!Array.isArray(deltas)) {
			return;
		}
		for (let position = 0; position < deltas.length; position++) {
			const delta: any = deltas[position];
			// Some servers omit `index` when there is only one call in flight.
			const index = typeof delta?.index === 'number' ? delta.index : position;
			const existing = this.toolCalls.get(index) ?? { id: '', name: '', args: '' };
			if (typeof delta?.id === 'string' && delta.id) {
				existing.id = delta.id;
			}
			if (typeof delta?.function?.name === 'string' && delta.function.name) {
				existing.name += delta.function.name;
			}
			if (typeof delta?.function?.arguments === 'string') {
				existing.args += delta.function.arguments;
			}
			this.toolCalls.set(index, existing);
		}
	}
}

/** `content` is a string for OpenAI, but an array of parts on some gateways. */
function extractText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	let text = '';
	for (const part of content) {
		if (typeof part === 'string') {
			text += part;
		} else if (part?.type === 'text' && typeof part.text === 'string') {
			text += part.text;
		}
	}
	return text;
}

function parseToolArguments(name: string, args: string): object {
	const trimmed = args.trim();
	if (trimmed === '') {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new StreamProtocolError(`Tool call "${name}" produced arguments that are not valid JSON: ${trimmed.slice(0, 200)}`);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new StreamProtocolError(`Tool call "${name}" produced non-object arguments: ${trimmed.slice(0, 200)}`);
	}
	return parsed;
}

/**
 * Fallback for providers that ignore `stream: true` and answer with a single
 * JSON body. Reuses the accumulator so both paths behave identically.
 */
export function eventsFromCompletion(body: unknown): StreamEvent[] {
	const accumulator = new ChatCompletionAccumulator();
	const events = accumulator.handle(JSON.stringify(body));
	return [...events, ...accumulator.finish()];
}
