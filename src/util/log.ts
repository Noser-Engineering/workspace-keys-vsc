import * as vscode from 'vscode';

export { LOGGABLE_HEADERS, MAX_BODY_LENGTH, redactHeaders, scrubSecret, truncateBody } from './redact';

let channel: vscode.LogOutputChannel | undefined;

const CHANNEL_NAME = 'Workspace Keys';

export function createLog(context: vscode.ExtensionContext): vscode.LogOutputChannel {
	channel = vscode.window.createOutputChannel(CHANNEL_NAME, { log: true });
	context.subscriptions.push(channel);
	return channel;
}

export function log(): vscode.LogOutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel(CHANNEL_NAME, { log: true });
	}
	return channel;
}
