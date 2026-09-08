import * as vscode from 'vscode';
import type { ProviderConfig } from '../types';
import { SECTION, type WorkspaceScope } from '../config/workspaceConfig';
import { KeyResolver } from '../auth/keyResolver';
import { log } from '../util/log';

/**
 * Warns when a literal key sits in workspace-scoped settings, and offers to move
 * it into SecretStorage.
 *
 * Only workspace-level values are reported: a key in the user's own settings is
 * their call, whereas a key in `.vscode/settings.json` is one `git add` away
 * from being published.
 */
export async function reviewPlaintextKeys(plaintext: readonly ProviderConfig[], scope: WorkspaceScope, keys: KeyResolver): Promise<void> {
	if (plaintext.length === 0 || !scope.workspaceKey) {
		return;
	}

	const names = plaintext.map((provider) => `"${provider.id}"`).join(', ');
	const choice = await vscode.window.showWarningMessage(
		`Workspace Keys: API key for ${names} is stored in plain text in workspace settings.`,
		{ detail: 'Anyone who can read .vscode/settings.json can read the key, and it is easy to commit by accident.', modal: false },
		'Move to SecretStorage',
		'Show Settings',
	);

	if (choice === 'Show Settings') {
		await vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile');
		return;
	}
	if (choice !== 'Move to SecretStorage') {
		return;
	}

	for (const provider of plaintext) {
		if (provider.apiKey) {
			await keys.store(provider.id, scope.workspaceKey, provider.apiKey, scope.identityUri);
		}
	}

	const removed = await stripKeysFromSettings(
		plaintext.map((provider) => provider.id),
		scope.folder,
	);
	if (removed) {
		void vscode.window.showInformationMessage('Workspace Keys: key moved to SecretStorage and removed from workspace settings.');
	} else {
		void vscode.window.showWarningMessage(
			'Workspace Keys: key stored in SecretStorage, but the plain-text value could not be removed automatically. Remove `apiKey` from workspace settings manually.',
		);
	}
}

/**
 * Removes the `apiKey` field from the given providers at whichever workspace
 * target actually defines them, leaving every other field untouched.
 */
async function stripKeysFromSettings(providerIds: readonly string[], folder: vscode.WorkspaceFolder | undefined): Promise<boolean> {
	const configuration = vscode.workspace.getConfiguration(SECTION, folder?.uri ?? null);
	const inspected = configuration.inspect<ProviderConfig[]>('providers');

	const targets: Array<{ target: vscode.ConfigurationTarget; value: ProviderConfig[] | undefined }> = [
		{ target: vscode.ConfigurationTarget.WorkspaceFolder, value: inspected?.workspaceFolderValue },
		{ target: vscode.ConfigurationTarget.Workspace, value: inspected?.workspaceValue },
	];

	let changed = false;
	for (const { target, value } of targets) {
		if (!Array.isArray(value)) {
			continue;
		}
		let touched = false;
		const rewritten = value.map((entry) => {
			if (entry && typeof entry === 'object' && providerIds.includes(entry.id) && 'apiKey' in entry) {
				touched = true;
				const { apiKey: _discarded, ...rest } = entry;
				return rest;
			}
			return entry;
		});
		if (!touched) {
			continue;
		}
		try {
			await configuration.update('providers', rewritten, target);
			changed = true;
		} catch (error) {
			log().error(`Could not rewrite providers at target ${target}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return changed;
}
