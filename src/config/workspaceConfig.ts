import * as vscode from 'vscode';
import type { ModelRule, ProviderConfig } from '../types';
import { containsEnvRef } from '../auth/env';
import { validateBaseUrl } from '../security/endpointUrl';

export const SECTION = 'workspaceKeys';

/** Provider ids become part of a SecretStorage key, so the character set is restricted. */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface WorkspaceScope {
	folder: vscode.WorkspaceFolder | undefined;
	/**
	 * Identity the SecretStorage key is derived from: the `.code-workspace` file
	 * when there is one, otherwise the folder URI. Undefined with no folder open.
	 */
	workspaceKey: string | undefined;
	/** The URI `workspaceKey` was built from, so its identity can be checked on disk. */
	identityUri: vscode.Uri | undefined;
}

/**
 * Where the effective provider list came from.
 *
 * VS Code replaces array settings rather than merging them, so the whole list
 * has one origin: if any workspace-level value exists it wins outright.
 *
 * This drives endpoint approval. A list the user wrote in their own settings is
 * self-evidently consented to; one that arrived with a cloned repository is not.
 */
export type ProviderOrigin = 'user' | 'workspace';

export interface ProviderReadResult {
	providers: ProviderConfig[];
	problems: string[];
	origin: ProviderOrigin;
	/** Providers whose key sits literally in workspace-scoped settings. */
	plaintextInWorkspace: ProviderConfig[];
}

export class ConfigReader {
	private lastFolder: vscode.WorkspaceFolder | undefined;

	/**
	 * Picks the workspace folder whose configuration applies.
	 *
	 * Single-root is unambiguous. For multi-root the active editor decides, with
	 * the last successful resolution as a fallback so that focusing a non-file
	 * editor does not silently switch providers.
	 */
	resolveFolder(): vscode.WorkspaceFolder | undefined {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			return undefined;
		}
		if (folders.length === 1) {
			this.lastFolder = folders[0];
			return folders[0];
		}

		const mode = vscode.workspace.getConfiguration(SECTION).get<string>('multiRootResolution', 'activeEditor');
		if (mode === 'firstFolder') {
			this.lastFolder = folders[0];
			return folders[0];
		}

		const activeUri = vscode.window.activeTextEditor?.document.uri;
		if (activeUri) {
			const owning = vscode.workspace.getWorkspaceFolder(activeUri);
			if (owning) {
				this.lastFolder = owning;
				return owning;
			}
		}

		const remembered = this.lastFolder;
		if (remembered && folders.some((f) => f.uri.toString() === remembered.uri.toString())) {
			return remembered;
		}
		this.lastFolder = folders[0];
		return folders[0];
	}

	currentScope(): WorkspaceScope {
		const folder = this.resolveFolder();
		const identityUri = vscode.workspace.workspaceFile ?? folder?.uri;
		return { folder, workspaceKey: identityUri?.toString(), identityUri };
	}

	readProviders(folder: vscode.WorkspaceFolder | undefined): ProviderReadResult {
		const configuration = vscode.workspace.getConfiguration(SECTION, folder?.uri ?? null);
		const raw = configuration.get<unknown[]>('providers', []);
		const inspected = configuration.inspect<ProviderConfig[]>('providers');
		const origin: ProviderOrigin =
			inspected?.workspaceFolderValue !== undefined || inspected?.workspaceValue !== undefined ? 'workspace' : 'user';

		const providers: ProviderConfig[] = [];
		const problems: string[] = [];
		const plaintextInWorkspace: ProviderConfig[] = [];
		const seen = new Set<string>();

		for (const [index, entry] of (Array.isArray(raw) ? raw : []).entries()) {
			const candidate = entry as Partial<ProviderConfig> | null;
			if (!candidate || typeof candidate !== 'object') {
				problems.push(`providers[${index}] is not an object.`);
				continue;
			}
			const { id, baseUrl } = candidate;
			if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) {
				problems.push(`providers[${index}] has an invalid id. Use letters, digits, '.', '_' or '-'.`);
				continue;
			}
			if (seen.has(id)) {
				problems.push(`providers[${index}] repeats the id "${id}"; only the first entry is used.`);
				continue;
			}
			const url =
				typeof baseUrl === 'string' ? validateBaseUrl(baseUrl, { allowInsecureLoopback: this.allowInsecureLoopback() }) : undefined;
			if (!url?.ok) {
				problems.push(`Provider "${id}" has no usable baseUrl. ${url ? url.message : 'Enter an https:// URL.'}`);
				continue;
			}

			seen.add(id);
			const provider: ProviderConfig = {
				id,
				baseUrl: url.baseUrl,
				...(typeof candidate.label === 'string' ? { label: candidate.label } : {}),
				...(typeof candidate.apiKey === 'string' ? { apiKey: candidate.apiKey } : {}),
				...(Array.isArray(candidate.models) ? { models: candidate.models.filter((m): m is string => typeof m === 'string') } : {}),
				...(candidate.headers && typeof candidate.headers === 'object' ? { headers: candidate.headers } : {}),
			};
			providers.push(provider);

			if (provider.apiKey && !containsEnvRef(provider.apiKey) && origin === 'workspace') {
				plaintextInWorkspace.push(provider);
			}
		}

		return { providers, problems, origin, plaintextInWorkspace };
	}

	/**
	 * Development opt-in for cleartext loopback endpoints. Application-scoped, so
	 * a workspace cannot turn cleartext transport back on for itself.
	 */
	allowInsecureLoopback(): boolean {
		return vscode.workspace.getConfiguration(SECTION).get<boolean>('allowInsecureLoopback', false);
	}

	/** Ids already present in the user-level list, so a new entry can avoid them. */
	userProviderIds(): string[] {
		const global = vscode.workspace.getConfiguration(SECTION).inspect<ProviderConfig[]>('providers')?.globalValue;
		return Array.isArray(global) ? global.map((entry) => entry?.id).filter((id): id is string => typeof id === 'string') : [];
	}

	/**
	 * Appends a provider to the **user** list.
	 *
	 * Deliberately additive and re-reading the current value first: a second
	 * window may have written its own entry in the meantime, and overwriting the
	 * whole array would silently drop it. Endpoints are never written to
	 * workspace settings — that origin exists for repositories to declare, not
	 * for this extension to fill in.
	 */
	async addUserProvider(entry: ProviderConfig): Promise<boolean> {
		const configuration = vscode.workspace.getConfiguration(SECTION);
		const current = configuration.inspect<ProviderConfig[]>('providers')?.globalValue;
		const list = Array.isArray(current) ? [...current] : [];
		if (list.some((existing) => existing?.id === entry.id)) {
			return false;
		}
		list.push(entry);
		await configuration.update('providers', list, vscode.ConfigurationTarget.Global);
		return true;
	}

	readModelRules(): ModelRule[] {
		const rules = vscode.workspace.getConfiguration(SECTION).get<ModelRule[]>('modelRules', []);
		return Array.isArray(rules) ? rules.filter((rule) => rule && typeof rule.match === 'string') : [];
	}

	hideUnknownModels(): boolean {
		return vscode.workspace.getConfiguration(SECTION).get<boolean>('hideUnknownModels', true);
	}

	readRequestDefaults(folder: vscode.WorkspaceFolder | undefined): Record<string, unknown> {
		const defaults = vscode.workspace
			.getConfiguration(SECTION, folder?.uri ?? null)
			.get<Record<string, unknown>>('requestDefaults', {});
		return defaults && typeof defaults === 'object' ? defaults : {};
	}
}
