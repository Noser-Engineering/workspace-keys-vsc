import * as vscode from 'vscode';
import { log } from './util/log';

const VENDOR = 'workspace-keys';

/**
 * Sends a real request through a contributed model and reports what came back.
 *
 * Exists because the obvious way to verify the extension — open Copilot Chat and
 * pick the model — depends on Copilot being installed and on the GitHub BYOK
 * policy being enabled. This path exercises registration, discovery, key
 * resolution, consent and the full streaming request without either.
 */
export async function runSelfTest(): Promise<void> {
	const models = await vscode.lm.selectChatModels({ vendor: VENDOR });

	if (models.length === 0) {
		const choice = await vscode.window.showWarningMessage(
			'Workspace Keys: no models are currently contributed.',
			{
				modal: true,
				detail:
					'Common causes, in the order worth checking:\n' +
					'• no provider endpoint configured yet\n' +
					'• no API key for this workspace yet\n' +
					'• no folder open\n' +
					'• the endpoint has not been approved\n' +
					'• the workspace is not trusted\n' +
					'• every discovered model was hidden by the model rules',
			},
			'Set API Key',
			'Manage',
			'Show Log',
		);
		if (choice === 'Show Log') {
			log().show();
		} else if (choice === 'Manage') {
			await vscode.commands.executeCommand('workspaceKeys.manage');
		} else if (choice === 'Set API Key') {
			await vscode.commands.executeCommand('workspaceKeys.setWorkspaceKey');
		}
		return;
	}

	const model =
		models.length === 1
			? models[0]
			: (
					await vscode.window.showQuickPick(
						models.map((candidate) => ({
							label: candidate.name,
							description: candidate.id,
							// LanguageModelChat is the consumer-side handle and carries no
							// capabilities; those live on LanguageModelChatInformation.
							detail: `${candidate.family} · max input ${candidate.maxInputTokens} tokens`,
							model: candidate,
						})),
						{ title: 'Workspace Keys · self-test', placeHolder: 'Which model should be probed?' },
					)
				)?.model;

	if (!model) {
		return;
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Probing ${model.name}…`, cancellable: true },
		async (_progress, token) => {
			const started = Date.now();
			try {
				const response = await model.sendRequest(
					[vscode.LanguageModelChatMessage.User('Reply with exactly the word: pong')],
					{},
					token,
				);

				let text = '';
				let firstChunkAfterMs: number | undefined;
				for await (const fragment of response.text) {
					firstChunkAfterMs ??= Date.now() - started;
					text += fragment;
				}

				const elapsed = Date.now() - started;
				log().info(
					`Self-test on "${model.id}" succeeded in ${elapsed} ms ` +
						`(first chunk after ${firstChunkAfterMs ?? elapsed} ms, ${text.length} characters).`,
				);
				log().info(`Response: ${text.trim()}`);

				const choice = await vscode.window.showInformationMessage(
					`Workspace Keys: "${model.name}" answered in ${elapsed} ms.`,
					{ detail: text.trim().slice(0, 300) || '(empty response)', modal: false },
					'Show Log',
				);
				if (choice === 'Show Log') {
					log().show();
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log().error(`Self-test on "${model.id}" failed: ${message}`);
				const choice = await vscode.window.showErrorMessage(`Workspace Keys: self-test failed: ${message}`, 'Show Log');
				if (choice === 'Show Log') {
					log().show();
				}
			}
		},
	);
}
