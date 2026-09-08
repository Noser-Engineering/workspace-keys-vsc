import * as http from 'node:http';
import { AddressInfo } from 'node:net';

export interface MockOptions {
	/** Number of 429 responses to send before the first successful completion. */
	rateLimitTimes?: number;
	/** Answer with a plain JSON body instead of an event stream. */
	nonStreaming?: boolean;
	models?: string[];
	/** Fixed port for the manual two-window test; tests use an ephemeral one. */
	port?: number;
}

export interface MockProvider {
	baseUrl: string;
	requests: Array<{ path: string; authorization: string | undefined; body: unknown }>;
	close: () => Promise<void>;
}

/**
 * Minimal OpenAI-compatible server used to exercise the real HTTP and SSE path.
 *
 * The stream is written in deliberately small, uneven pieces so that TCP
 * delivers chunk boundaries in the middle of JSON payloads and of `\r\n` pairs
 * — the case a hand-built fixture tends not to reproduce.
 */
export async function startMockProvider(options: MockOptions = {}): Promise<MockProvider> {
	const requests: MockProvider['requests'] = [];
	let rateLimitRemaining = options.rateLimitTimes ?? 0;

	const server = http.createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			requests.push({
				path: request.url ?? '',
				authorization: request.headers.authorization,
				body: raw ? JSON.parse(raw) : undefined,
			});

			if (request.url?.endsWith('/models')) {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(
					JSON.stringify({
						data: (options.models ?? ['gpt-4o-mini', 'text-embedding-3-small', 'internal-secret-model']).map((id) => ({ id })),
					}),
				);
				return;
			}

			if (rateLimitRemaining > 0) {
				rateLimitRemaining--;
				response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
				response.end(JSON.stringify({ error: { message: 'rate limited' } }));
				return;
			}

			if (options.nonStreaming) {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(
					JSON.stringify({
						choices: [{ message: { content: 'non-streamed answer' }, finish_reason: 'stop' }],
					}),
				);
				return;
			}

			response.writeHead(200, {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
				connection: 'keep-alive',
			});
			void writeStream(response);
		});
	});

	await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

async function writeStream(response: http.ServerResponse): Promise<void> {
	const events = [
		{ choices: [{ delta: { role: 'assistant', content: '' } }] },
		{ choices: [{ delta: { content: 'Reading ' } }] },
		{ choices: [{ delta: { content: 'the file' } }] },
		{
			choices: [
				{ delta: { tool_calls: [{ index: 0, id: 'call_42', type: 'function', function: { name: 'read_', arguments: '' } }] } },
			],
		},
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"pa' } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"src/' } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'a.ts","dee' } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'p":{"n":1}}' } }] } }] },
		{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
	];

	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')}: keep-alive\r\n\r\ndata: [DONE]\r\n\r\n`;

	// Uneven slices, flushed separately, so boundaries land inside payloads.
	let offset = 0;
	const sizes = [7, 23, 3, 61, 1, 137, 11];
	let index = 0;
	while (offset < body.length) {
		const size = sizes[index++ % sizes.length];
		response.write(body.slice(offset, offset + size));
		offset += size;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	response.end();
}
