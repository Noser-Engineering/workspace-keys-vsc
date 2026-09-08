import * as vscode from 'vscode';
import type { ProviderConfig } from './types';
import { isResolvedKey } from './types';
import { ConfigReader, type ProviderOrigin, type WorkspaceScope } from './config/workspaceConfig';
import { deriveProviderId, sanitizeProviderTitle, suggestProviderTitle } from './config/providerDraft';
import { KeyResolver } from './auth/keyResolver';
import { BaseUrlConsent, originOf } from './security/baseUrlConsent';
import { validateBaseUrl } from './security/endpointUrl';
import { WorkspaceKeysChatProvider } from './provider/chatProvider';
import { runSelfTest } from './selfTest';
import { log } from './util/log';

export interface CommandDeps {
	config: ConfigReader;
	keys: KeyResolver;
	consent: BaseUrlConsent;
	provider: WorkspaceKeysChatProvider;
}

/**
 * Four commands carry a decision worth a Command Palette entry: add an endpoint,
 * supply a key, edit the endpoint list, clean up stored keys. Everything else —
 * test request, log, refresh, model rules, clearing a single key, endpoint
 * approval — is situational and lives behind `manage`, reached from the status
 * bar and the model picker.
 *
 * `manage` is registered but hidden from the palette: it is the provider's
 * `managementCommand`, and notifications route to it.
 */
export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand('workspaceKeys.setWorkspaceKey', (providerId?: string) => setKey(deps, providerId)),
		vscode.commands.registerCommand('workspaceKeys.addProvider', () => addProvider(deps)),
		vscode.commands.registerCommand('workspaceKeys.editProviders', () => editSetting('workspaceKeys.providers')),
		vscode.commands.registerCommand('workspaceKeys.manageStoredKeys', () => manageStoredKeys(deps)),
		vscode.commands.registerCommand('workspaceKeys.manage', () => manage(deps)),
	];
}

/**
 * Opens a setting in the user's `settings.json`.
 *
 * A JSON editor rather than a wizard: the setup dialog covers the common case of
 * a first endpoint, so the list is edited rarely, and the schema in
 * `package.json` supplies completion and validation for the times it is.
 */
async function editSetting(key: string): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key } });
}

/**
 * Asks for an endpoint and writes it to the **user** settings.
 *
 * The extension ships no endpoint of its own, so this is the one place a first
 * provider comes from. Three properties matter:
 *
 * - The endpoint goes to user settings, because it is a fact about the machine,
 *   while the key is a fact about the project. Writing it to workspace settings
 *   would put it into a file that is one `git add` away from being published.
 * - The URL is shown back in the confirmation. Entering it *is* the consent that
 *   `approvalPolicy` grants to user-declared endpoints, so it must be visible.
 * - The title is a suggestion derived from the host, and stays editable: it is
 *   cosmetic, whereas the derived id becomes part of the SecretStorage name.
 */
async function addProvider(deps: CommandDeps): Promise<ProviderConfig | undefined> {
	const allowInsecureLoopback = deps.config.allowInsecureLoopback();

	const entered = await vscode.window.showInputBox({
		title: 'Add a provider endpoint',
		prompt: 'Base URL of an OpenAI-compatible API, including the version path.',
		placeHolder: 'https://api.example.com/v1',
		ignoreFocusOut: true,
		validateInput: (value) => {
			const result = validateBaseUrl(value, { allowInsecureLoopback });
			return result.ok ? undefined : result.message;
		},
	});
	if (entered === undefined) {
		return undefined;
	}
	const url = validateBaseUrl(entered, { allowInsecureLoopback });
	if (!url.ok) {
		void vscode.window.showWarningMessage(`Workspace Keys: ${url.message}`);
		return undefined;
	}

	const enteredTitle = await vscode.window.showInputBox({
		title: 'Title for this endpoint',
		prompt: 'Shown next to the models in the picker and in the status bar. Change it whenever you like.',
		value: suggestProviderTitle(url.baseUrl),
		ignoreFocusOut: true,
		validateInput: (value) => (sanitizeProviderTitle(value).length === 0 ? 'The title must not be empty.' : undefined),
	});
	if (enteredTitle === undefined) {
		return undefined;
	}
	const title = sanitizeProviderTitle(enteredTitle);
	if (title.length === 0) {
		return undefined;
	}

	const id = deriveProviderId(title, deps.config.userProviderIds());
	const confirmed = await vscode.window.showInformationMessage(
		`Add the endpoint "${title}"?`,
		{
			modal: true,
			detail:
				`Endpoint: ${url.baseUrl}\nIdentifier: ${id}\n\n` +
				'Prompts sent to models of this endpoint go to this address. It is stored in your user settings and applies to every workspace; ' +
				'the API key is stored separately per workspace.\n\n' +
				'The title can be changed at any time. The identifier is part of the SecretStorage name of its key, so renaming it later detaches the stored key.',
		},
		'Add Endpoint',
	);
	if (confirmed !== 'Add Endpoint') {
		return undefined;
	}

	const entry: ProviderConfig = { id, label: title, baseUrl: url.baseUrl };
	const written = await deps.config.addUserProvider(entry);
	if (!written) {
		void vscode.window.showWarningMessage(`Workspace Keys: a provider with the id "${id}" already exists in your user settings.`);
		return undefined;
	}
	log().info(`Added provider "${id}" (${url.origin}) to the user settings.`);
	deps.provider.refresh();
	return entry;
}

/**
 * Confirms a workspace-declared endpoint before a key is even entered.
 *
 * `.vscode/settings.json` arrives with a repository, so the endpoint a key would
 * be sent to is not necessarily one the user chose. Asking here — with the full
 * URL, not just the origin — keeps a key from being stored for an endpoint the
 * user would not have approved.
 */
async function confirmWorkspaceEndpoint(deps: CommandDeps, provider: ProviderConfig): Promise<boolean> {
	if (deps.consent.isApproved(provider.baseUrl, 'workspace')) {
		return true;
	}

	const choice = await vscode.window.showWarningMessage(
		`Trust the endpoint of provider "${provider.label ?? provider.id}"?`,
		{
			modal: true,
			detail:
				`${provider.baseUrl}\n\n` +
				'This endpoint comes from this workspace, not from your own user settings. Approve it only if you trust it with the content of ' +
				'your prompts and with the API key you are about to store.',
		},
		'Trust Endpoint',
	);
	if (choice !== 'Trust Endpoint') {
		log().info(`Endpoint ${provider.baseUrl} was not trusted; no key was requested.`);
		return false;
	}

	await deps.consent.approve(provider.baseUrl);
	deps.provider.refresh();
	return true;
}

async function manage(deps: CommandDeps): Promise<void> {
	const scope = deps.config.currentScope();
	const { providers, problems, origin } = deps.config.readProviders(scope.folder);
	const storedCount = deps.keys.storedKeys().length;

	const items: Array<vscode.QuickPickItem & { run?: () => Thenable<unknown> | void }> = [];

	if (providers.length > 0) {
		items.push({ label: 'Providers', kind: vscode.QuickPickItemKind.Separator });
		for (const provider of providers) {
			items.push({
				label: `$(server) ${provider.label ?? provider.id}`,
				description: await statusOf(deps, provider, scope, origin),
				detail: provider.baseUrl,
				run: () => setKey(deps, provider.id),
			});
		}
	} else {
		// The state a fresh installation starts in: no endpoint ships with the
		// extension, so the first one is added here.
		items.push({
			label: '$(add) Add a provider endpoint',
			detail: 'No endpoint is configured yet — stored in your user settings, used by every workspace',
			run: () => addProvider(deps),
		});
	}

	if (problems.length > 0) {
		items.push({
			label: `$(error) ${problems.length} configuration problem(s)`,
			detail: problems[0],
			run: () => log().show(),
		});
	}

	// Only offered when something is actually pending. The shipped endpoint needs
	// no approval, so for most installations this never appears.
	if (providers.some((provider) => !deps.consent.isApproved(provider.baseUrl, origin))) {
		items.push({
			label: '$(unverified) Approve an endpoint',
			description: 'declared in workspace settings',
			run: () => approveEndpoint(deps),
		});
	}

	items.push(
		{ label: 'Actions', kind: vscode.QuickPickItemKind.Separator },
		{ label: '$(key) Set or update API key for current workspace', run: () => setKey(deps) },
		{ label: '$(trash) Clear API key for current workspace', run: () => clearKey(deps) },
		{
			label: '$(add) Add a provider endpoint',
			description: 'user settings',
			run: () => addProvider(deps),
		},
		{
			label: `$(archive) Stored keys${storedCount > 0 ? ` (${storedCount})` : ''}`,
			description: 'every workspace, including deleted ones',
			run: () => manageStoredKeys(deps),
		},
		{
			label: '$(gear) Edit providers',
			description: 'User Settings',
			run: () => editSetting('workspaceKeys.providers'),
		},
		{
			label: '$(settings-gear) Edit model rules',
			description: 'User Settings',
			run: () => editSetting('workspaceKeys.modelRules'),
		},
		{ label: 'Diagnostics', kind: vscode.QuickPickItemKind.Separator },
		{ label: '$(beaker) Send a test request', run: () => runSelfTest() },
		{
			label: '$(refresh) Refresh model list',
			description: 'happens automatically; this forces it',
			run: () => deps.provider.refresh(),
		},
		{ label: '$(shield) Manage approved endpoints', run: () => manageEndpoints(deps) },
		{ label: '$(output) Show log', run: () => log().show() },
	);

	const picked = await vscode.window.showQuickPick(items, {
		title: `Workspace Keys${scope.folder ? ` · ${scope.folder.name}` : ''}`,
		placeHolder: 'Select a provider to set its key, or pick an action',
	});
	await picked?.run?.();
}

async function statusOf(deps: CommandDeps, provider: ProviderConfig, scope: WorkspaceScope, origin: ProviderOrigin): Promise<string> {
	const resolution = await deps.keys.resolve(provider, scope, origin);
	if (!isResolvedKey(resolution)) {
		switch (resolution.reason) {
			case 'withheld':
				return '$(lock) key withheld · path was reused';
			case 'missing-env':
				return `$(error) ${resolution.envNames.join(', ')} not set`;
			case 'workspace-env-blocked':
				return `$(error) \${env:${resolution.envNames.join(', ')}} blocked in workspace settings`;
			default:
				return '$(error) no key';
		}
	}
	const approved = deps.consent.isApproved(provider.baseUrl, origin) ? '' : ' · $(unverified) endpoint not approved';
	const source = { secret: 'SecretStorage', env: 'environment', plaintext: '$(warning) plain text' }[resolution.source];
	return `key: ${source}${approved}`;
}

async function pickProvider(
	deps: CommandDeps,
	providerId: string | undefined,
	placeHolder: string,
	known?: readonly ProviderConfig[],
): Promise<ProviderConfig | undefined> {
	const scope = deps.config.currentScope();
	const providers = known ?? deps.config.readProviders(scope.folder).providers;

	if (providers.length === 0) {
		const choice = await vscode.window.showWarningMessage(
			'Workspace Keys: no provider endpoint is configured for this workspace.',
			'Add Endpoint',
		);
		if (choice === 'Add Endpoint') {
			await addProvider(deps);
		}
		return undefined;
	}
	if (providerId) {
		return providers.find((provider) => provider.id === providerId);
	}
	if (providers.length === 1) {
		return providers[0];
	}

	const picked = await vscode.window.showQuickPick(
		providers.map((provider) => ({ label: provider.label ?? provider.id, description: provider.baseUrl, provider })),
		{ placeHolder },
	);
	return picked?.provider;
}

/**
 * The one entry point that has to work on a fresh installation, so it carries
 * the setup: without an endpoint there is nothing a key could belong to, and a
 * workspace-declared endpoint has to be trusted before a key is even asked for.
 */
async function setKey(deps: CommandDeps, providerId?: string): Promise<void> {
	const scope = deps.config.currentScope();
	if (!scope.workspaceKey) {
		void vscode.window.showWarningMessage('Workspace Keys: open a folder or workspace before setting a workspace key.');
		return;
	}

	let { providers, origin } = deps.config.readProviders(scope.folder);
	if (providers.length === 0) {
		const added = await addProvider(deps);
		if (!added) {
			return;
		}
		providers = [added];
		origin = 'user';
	}

	const provider = await pickProvider(deps, providerId, 'Which provider should the key apply to?', providers);
	if (!provider) {
		return;
	}

	if (origin === 'workspace' && !(await confirmWorkspaceEndpoint(deps, provider))) {
		return;
	}

	const key = await vscode.window.showInputBox({
		title: `API key for "${provider.label ?? provider.id}"`,
		prompt: `Stored in SecretStorage for this workspace only. It is not written to settings.`,
		password: true,
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim().length === 0 ? 'The key must not be empty.' : undefined),
	});
	if (key === undefined) {
		return;
	}

	await deps.keys.store(provider.id, scope.workspaceKey, key.trim(), scope.identityUri);
	log().info(`Stored a key for provider "${provider.id}" in this workspace.`);
	void vscode.window.showInformationMessage(`Workspace Keys: key for "${provider.label ?? provider.id}" stored for this workspace.`);
	deps.provider.refresh();
}

async function clearKey(deps: CommandDeps, providerId?: string): Promise<void> {
	const scope = deps.config.currentScope();
	if (!scope.workspaceKey) {
		return;
	}
	const provider = await pickProvider(deps, providerId, 'Which provider should lose its stored key?');
	if (!provider) {
		return;
	}
	await deps.keys.clear(provider.id, scope.workspaceKey);
	log().info(`Cleared the stored key for provider "${provider.id}".`);
	void vscode.window.showInformationMessage(`Workspace Keys: stored key for "${provider.label ?? provider.id}" removed.`);
	deps.provider.refresh();
}

/**
 * Lists every key this extension knows it stored, and lets any of them go.
 *
 * The only place a key stored for a workspace that no longer exists can be
 * reached: its SecretStorage name is a hash of a path that is gone, so there is
 * nothing left to derive it from — only the index still holds the name.
 *
 * Nothing here is automatic. "The folder is missing" is not evidence that a key
 * is obsolete: an unmounted share, a VPN that is down or a drive that is not
 * plugged in look exactly the same, and deleting a key on that basis is not
 * reversible.
 */
async function manageStoredKeys(deps: CommandDeps): Promise<void> {
	const stored = deps.keys.storedKeys();
	if (stored.length === 0) {
		void vscode.window.showInformationMessage('Workspace Keys: no API keys are stored for any workspace.');
		return;
	}

	const workspaceKey = deps.config.currentScope().workspaceKey;
	const currentName = workspaceKey ? (providerId: string) => deps.keys.secretNameFor(providerId, workspaceKey) : undefined;

	const items = stored.map((entry) => {
		const isCurrent = currentName?.(entry.providerId) === entry.name;
		const stamp = entry.adopted ? 'first seen' : 'stored';
		const lastUsed = entry.lastUsedAt ? ` · last used ${formatDate(entry.lastUsedAt)}` : '';
		return {
			label: `$(key) ${entry.providerId}`,
			description: `${entry.label}${isCurrent ? ' · this workspace' : ''}`,
			detail: `${stamp} ${formatDate(entry.storedAt)}${lastUsed}`,
			name: entry.name,
		};
	});

	const picked = await vscode.window.showQuickPick(items, {
		title: 'Workspace Keys · stored API keys',
		placeHolder: 'Select the keys to delete — nothing is deleted until you confirm',
		canPickMany: true,
	});
	if (!picked || picked.length === 0) {
		return;
	}

	const confirmed = await vscode.window.showWarningMessage(
		`Delete ${picked.length} stored API key(s)?`,
		{
			modal: true,
			detail:
				'They are removed from SecretStorage and cannot be recovered — the provider would have to issue a new key.\n\n' +
				'Deleting a key here does not revoke it at the provider.',
		},
		'Delete',
	);
	if (confirmed !== 'Delete') {
		return;
	}

	await deps.keys.forget(picked.map((item) => item.name));
	log().info(`Deleted ${picked.length} stored key(s).`);
	void vscode.window.showInformationMessage(`Workspace Keys: ${picked.length} stored key(s) deleted.`);
	deps.provider.refresh();
}

function formatDate(epochMs: number): string {
	return new Date(epochMs).toLocaleDateString();
}

/**
 * Explicit approval path for a configured endpoint.
 *
 * Discovery asks for approval only when VS Code calls it with `silent: false`,
 * which in practice means "the user opened the model picker". Without this
 * command a non-loopback endpoint could never be approved on a machine that has
 * no Copilot Chat picker to open — the provider would just stay silently empty.
 */
async function approveEndpoint(deps: CommandDeps): Promise<void> {
	const scope = deps.config.currentScope();
	const { providers, origin } = deps.config.readProviders(scope.folder);
	const pending = providers.filter((provider) => !deps.consent.isApproved(provider.baseUrl, origin));

	if (providers.length === 0) {
		void vscode.window.showWarningMessage('Workspace Keys: no provider endpoint is configured for this workspace.');
		return;
	}
	if (pending.length === 0) {
		void vscode.window.showInformationMessage('Workspace Keys: every configured endpoint is already approved.');
		return;
	}

	const picked =
		pending.length === 1
			? pending[0]
			: (
					await vscode.window.showQuickPick(
						pending.map((provider) => ({ label: provider.label ?? provider.id, description: provider.baseUrl, provider })),
						{ title: 'Approve endpoint', placeHolder: 'Which endpoint should be approved?' },
					)
				)?.provider;

	if (!picked) {
		return;
	}

	// Routed through the same consent gate as discovery, so the security warning
	// is shown here too rather than being bypassed.
	if (await deps.consent.ensure(picked.baseUrl, picked.label ?? picked.id, false, origin)) {
		deps.provider.refresh();
	}
}

async function manageEndpoints(deps: CommandDeps): Promise<void> {
	const approved = deps.consent.list();
	if (approved.length === 0) {
		void vscode.window.showInformationMessage('Workspace Keys: no endpoints have been approved yet.');
		return;
	}
	const picked = await vscode.window.showQuickPick(
		[...approved.map((origin) => ({ label: origin, description: 'Revoke' })), { label: '$(trash) Revoke all', description: '' }],
		{ title: 'Approved endpoints', placeHolder: 'Select an endpoint to revoke its approval' },
	);
	if (!picked) {
		return;
	}
	if (picked.label.includes('Revoke all')) {
		await deps.consent.revokeAll();
	} else {
		await deps.consent.revoke(originOf(picked.label) ?? picked.label);
	}
	deps.provider.refresh();
}
