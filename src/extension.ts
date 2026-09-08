import * as vscode from 'vscode';
import { ConfigReader, SECTION } from './config/workspaceConfig';
import { KeyResolver } from './auth/keyResolver';
import { KeyRegistry } from './auth/keyRegistry';
import { isOwnSecret } from './auth/secretKey';
import { BaseUrlConsent } from './security/baseUrlConsent';
import { reviewPlaintextKeys } from './security/plaintextKeys';
import { ModelCatalog } from './provider/models';
import { WorkspaceKeysChatProvider } from './provider/chatProvider';
import { ScopeStatusBar } from './statusBar';
import { registerCommands } from './commands';
import { createLog, log } from './util/log';
import { debounce } from './util/debounce';

const VENDOR = 'workspace-keys';
const REFRESH_DEBOUNCE_MS = 250;

export function activate(context: vscode.ExtensionContext): void {
	createLog(context);
	log().info(`Workspace Keys activated (trusted: ${vscode.workspace.isTrusted}).`);

	const config = new ConfigReader();
	// Not registered for Settings Sync: the index describes secrets of *this*
	// machine, and syncing it would have one machine reasoning about — and
	// offering to delete — keys another machine holds.
	const registry = new KeyRegistry(context.globalState);
	const keys = new KeyResolver(context.secrets, registry);
	const consent = new BaseUrlConsent(context);
	const catalog = new ModelCatalog();
	const provider = new WorkspaceKeysChatProvider(config, keys, consent, catalog);
	const statusBar = new ScopeStatusBar();

	const refresh = debounce(() => provider.refresh(), REFRESH_DEBOUNCE_MS);

	context.subscriptions.push(
		provider,
		statusBar,
		refresh,
		vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
		provider.onDidDescribeScope((description) => statusBar.update(description)),
		...registerCommands({ config, keys, consent, provider }),
	);

	// A key in workspace settings is only warned about when the set of affected
	// providers actually changes, so editing unrelated settings does not nag.
	let warnedSignature = '';
	const reviewKeys = async (): Promise<void> => {
		if (!vscode.workspace.isTrusted) {
			return;
		}
		const scope = config.currentScope();
		const { plaintextInWorkspace } = config.readProviders(scope.folder);
		const signature = plaintextInWorkspace
			.map((entry) => entry.id)
			.sort()
			.join(',');
		if (signature === warnedSignature) {
			return;
		}
		warnedSignature = signature;
		if (signature.length > 0) {
			await reviewPlaintextKeys(plaintextInWorkspace, scope, keys);
		}
	};

	let lastFolder = config.resolveFolder()?.uri.toString();

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration(SECTION)) {
				return;
			}
			refresh.trigger();
			void reviewKeys();
		}),
		context.secrets.onDidChange((event) => {
			if (isOwnSecret(event.key)) {
				refresh.trigger();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			lastFolder = config.resolveFolder()?.uri.toString();
			refresh.trigger();
		}),
		vscode.workspace.onDidGrantWorkspaceTrust(() => {
			log().info('Workspace trust granted; re-reading configuration.');
			refresh.trigger();
			void reviewKeys();
		}),
		vscode.window.onDidChangeActiveTextEditor(() => {
			// Only meaningful in a multi-root workspace, and only when the resolved
			// folder actually changed — otherwise every tab switch rebuilds the list.
			const folders = vscode.workspace.workspaceFolders;
			if (!folders || folders.length < 2) {
				return;
			}
			const current = config.resolveFolder()?.uri.toString();
			if (current === lastFolder) {
				return;
			}
			lastFolder = current;
			log().debug(`Active workspace folder changed to ${current ?? '<none>'}.`);
			refresh.trigger();
		}),
	);

	void reviewKeys();
}

export function deactivate(): void {
	// Everything is disposed through context.subscriptions.
}
