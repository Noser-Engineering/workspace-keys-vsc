import * as vscode from 'vscode';
import { mergeRequestParameters, sanitizeModelOptions } from './modelOptions';

export interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export type OpenAIContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type OpenAIMessage =
	| { role: 'user'; content: string | OpenAIContentPart[] }
	| { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
	| { role: 'tool'; tool_call_id: string; content: string };

/**
 * Maps VS Code chat messages onto the OpenAI wire format.
 *
 * Two shape mismatches drive the structure here:
 * - VS Code only knows the User and Assistant roles, so tool results arrive
 *   inside a User message and have to be split out into `role: "tool"` messages,
 *   one per `tool_call_id`.
 * - `LanguageModelDataPart` is not part of the `LanguageModelInputPart` union,
 *   but does arrive at runtime through the `| unknown` in `content`.
 */
export function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
	const converted: OpenAIMessage[] = [];

	for (const message of messages) {
		const isUser = message.role === vscode.LanguageModelChatMessageRole.User;
		const text: string[] = [];
		const images: OpenAIContentPart[] = [];
		const toolCalls: OpenAIToolCall[] = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text.push(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				// Emitted before the surrounding message so it directly follows the
				// assistant turn that requested it.
				converted.push({ role: 'tool', tool_call_id: part.callId, content: stringifyToolResult(part.content) });
			} else if (part instanceof vscode.LanguageModelDataPart) {
				const dataPart = toContentPart(part);
				if (dataPart?.type === 'image_url') {
					images.push(dataPart);
				} else if (dataPart?.type === 'text') {
					text.push(dataPart.text);
				}
			}
		}

		const joined = text.join('');

		if (isUser) {
			if (images.length > 0) {
				const parts: OpenAIContentPart[] = [];
				if (joined) {
					parts.push({ type: 'text', text: joined });
				}
				parts.push(...images);
				converted.push({ role: 'user', content: parts });
			} else if (joined) {
				converted.push({ role: 'user', content: joined });
			}
		} else if (toolCalls.length > 0) {
			converted.push({ role: 'assistant', content: joined || null, tool_calls: toolCalls });
		} else if (joined) {
			converted.push({ role: 'assistant', content: joined });
		}
	}

	return converted;
}

function toContentPart(part: vscode.LanguageModelDataPart): OpenAIContentPart | undefined {
	const mime = part.mimeType || 'application/octet-stream';
	if (mime.startsWith('image/')) {
		const base64 = Buffer.from(part.data).toString('base64');
		return { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } };
	}
	if (mime.startsWith('text/') || mime === 'application/json') {
		return { type: 'text', text: Buffer.from(part.data).toString('utf8') };
	}
	return undefined;
}

function stringifyToolResult(content: readonly unknown[]): string {
	const pieces: string[] = [];
	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			pieces.push(part.value);
		} else if (part instanceof vscode.LanguageModelDataPart) {
			const converted = toContentPart(part);
			pieces.push(converted?.type === 'text' ? converted.text : `[${part.mimeType}]`);
		} else if (part instanceof vscode.LanguageModelPromptTsxPart) {
			pieces.push(JSON.stringify(part.value));
		} else if (typeof part === 'string') {
			pieces.push(part);
		} else if (part !== undefined && part !== null) {
			pieces.push(JSON.stringify(part));
		}
	}
	// An empty tool result would be dropped by some servers; send an explicit marker.
	return pieces.join('\n') || '(no output)';
}

export function convertTools(tools: readonly vscode.LanguageModelChatTool[] | undefined) {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema ?? { type: 'object', properties: {} },
		},
	}));
}

export function toolChoiceFor(mode: vscode.LanguageModelChatToolMode | undefined, hasTools: boolean): 'auto' | 'required' | undefined {
	if (!hasTools) {
		return undefined;
	}
	return mode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
}

export interface BuildBodyInput {
	modelId: string;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
	defaults: Record<string, unknown>;
	maxOutputTokens: number;
}

export function buildRequestBody(input: BuildBodyInput): { body: Record<string, unknown>; droppedModelOptions: string[] } {
	const tools = convertTools(input.options.tools);
	const choice = toolChoiceFor(input.options.toolMode, tools !== undefined);
	const { forwarded, dropped } = sanitizeModelOptions(input.options.modelOptions);

	return {
		body: {
			...mergeRequestParameters(input.maxOutputTokens, input.defaults, forwarded),
			model: input.modelId,
			messages: convertMessages(input.messages),
			stream: true,
			...(tools ? { tools } : {}),
			...(choice ? { tool_choice: choice } : {}),
		},
		droppedModelOptions: dropped,
	};
}
