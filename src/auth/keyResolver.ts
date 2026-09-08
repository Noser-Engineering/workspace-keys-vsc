// Type-only, so the resolution logic — including the reuse guard — stays
// testable with plain `node --test`.
import type * as vscode from 'vscode';
import type { KeyResolution, ProviderConfig, WithheldKey } from '../types';
import type { ProviderOrigin } from '../config/workspaceConfig';
import { containsEnvRef, envRefNames, interpolateEnv } from './env';
import { secretName, workspaceHash } from './secretKey';
import { KeyRegistry, type StoredKey, isRecycled, pathLabel } from './keyRegistry';
import { type IdentitySource, birthtimeOf } from './workspaceIdentity';

/**
 * The parts of a `WorkspaceScope` key resolution needs. Declared structurally so
 * this module does not have to depend on the configuration layer, and so a
 * `vscode.Uri` satisfies `identityUri` as-is.
 */
export interface KeyScope {
	workspaceKey: string | undefined;
	identityUri: IdentitySource | undefined;
}

/**
 * Three-tier key resolution, first hit wins:
 *
 * 1. workspace-scoped SecretStorage entry — never touches settings,
 * 2. `${env:NAME}` in the provider entry — portable across machines, honoured
 *    only when the entry comes from user settings (see `resolve`),
 * 3. a literal value in the provider entry — reported so it can be warned about.
 *
 * Tier 1 additionally passes through a reuse check: see `guard`.
 */
export class KeyResolver {
	/**
	 * Creation times by path. A birthtime cannot change while the path keeps
	 * pointing at the same directory, so caching it is safe and keeps discovery
	 * off the disk. Failures are not cached — an offline share that comes back
	 * must be able to answer on the next pass.
	 */
	private readonly birthtimes = new Map<string, number>();

	/**
	 * Resolutions by `providerId|origin|workspaceKey`. `SecretStorage.get` is a
	 * roundtrip to the OS keychain and discovery runs often, silently included;
	 * without this every background pass pays one keychain hit per provider.
	 * Invalidated on every write here and by `WorkspaceKeysChatProvider.refresh()`,
	 * which already hangs off secret, configuration, folder and trust changes.
	 */
	private readonly resolutions = new Map<string, KeyResolution>();

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly registry: KeyRegistry,
		private readonly env: Record<string, string | undefined> = process.env,
		/** Injectable so the guard can be tested without depending on real file timestamps. */
		private readonly probe: (source: IdentitySource | undefined) => Promise<number | undefined> = birthtimeOf,
	) {}

	secretNameFor(providerId: string, workspaceKey: string): string {
		return secretName(providerId, workspaceHash(workspaceKey));
	}

	/**
	 * @param origin where the provider entry came from. `${env:}` references are
	 * only resolved for `user` entries: a workspace's `.vscode/settings.json`
	 * arrives with the repository, and honouring its `${env:NAME}` would hand any
	 * cloned repo read access to the user's environment — tokens included.
	 */
	async resolve(provider: ProviderConfig, scope: KeyScope, origin: ProviderOrigin): Promise<KeyResolution> {
		const memoKey = `${provider.id}|${origin}|${scope.workspaceKey ?? ''}`;
		const memoised = this.resolutions.get(memoKey);
		if (memoised) {
			return memoised;
		}
		const resolution = await this.resolveUncached(provider, scope, origin);
		this.resolutions.set(memoKey, resolution);
		return resolution;
	}

	/** Drops memoised resolutions, forcing the next `resolve` back to SecretStorage. */
	invalidate(): void {
		this.resolutions.clear();
	}

	private async resolveUncached(provider: ProviderConfig, scope: KeyScope, origin: ProviderOrigin): Promise<KeyResolution> {
		if (scope.workspaceKey) {
			const name = this.secretNameFor(provider.id, scope.workspaceKey);
			const stored = await this.secrets.get(name);
			if (stored) {
				const withheld = await this.guard(name, provider.id, scope);
				return withheld ? { reason: 'withheld', envNames: [], withheld } : { key: stored, source: 'secret' };
			}
		}

		const configured = provider.apiKey?.trim();
		if (!configured) {
			return { reason: 'absent', envNames: [] };
		}

		if (containsEnvRef(configured)) {
			if (origin === 'workspace') {
				return { reason: 'workspace-env-blocked', envNames: envRefNames(configured) };
			}
			const { value, missing } = interpolateEnv(configured, this.env);
			if (missing.length > 0) {
				return { reason: 'missing-env', envNames: missing };
			}
			return { key: value, source: 'env' };
		}

		return { key: configured, source: 'plaintext' };
	}

	/**
	 * Withholds a stored key when the path it was stored for now points at a
	 * different directory than it did then.
	 *
	 * A SecretStorage name is a hash of the path only, so deleting a project and
	 * later creating an unrelated one at the same path would otherwise hand the
	 * old key to the new project without a word. Comparing the recorded creation
	 * time catches exactly that case and no other: with no creation time on
	 * either side the key stays usable, and a key that predates the index is
	 * adopted rather than withheld.
	 */
	private async guard(name: string, providerId: string, scope: KeyScope): Promise<WithheldKey | undefined> {
		if (!scope.workspaceKey) {
			return undefined;
		}
		const birthtimeMs = await this.birthtime(scope.identityUri);
		const record = this.registry.get(name);

		if (!record) {
			await this.registry.adopt(name, {
				providerId,
				hash: workspaceHash(scope.workspaceKey),
				label: pathLabel(scope.workspaceKey),
				birthtimeMs,
			});
			return undefined;
		}

		if (!isRecycled(record, birthtimeMs)) {
			void this.registry.touch(name);
			return undefined;
		}

		return { providerId, secretName: name, label: record.label, storedAt: record.storedAt };
	}

	private async birthtime(identityUri: IdentitySource | undefined): Promise<number | undefined> {
		if (!identityUri || identityUri.scheme !== 'file') {
			return undefined;
		}
		const cached = this.birthtimes.get(identityUri.fsPath);
		if (cached !== undefined) {
			return cached;
		}
		const value = await this.probe(identityUri);
		if (value !== undefined) {
			this.birthtimes.set(identityUri.fsPath, value);
		}
		return value;
	}

	async store(providerId: string, workspaceKey: string, key: string, identityUri?: IdentitySource): Promise<void> {
		const name = this.secretNameFor(providerId, workspaceKey);
		await this.secrets.store(name, key);
		await this.registry.record(name, {
			providerId,
			hash: workspaceHash(workspaceKey),
			label: pathLabel(workspaceKey),
			birthtimeMs: await this.birthtime(identityUri),
		});
		this.invalidate();
	}

	async clear(providerId: string, workspaceKey: string): Promise<void> {
		await this.forget([this.secretNameFor(providerId, workspaceKey)]);
	}

	/**
	 * Accepts a withheld key for the directory that is at the path now, by
	 * re-recording it against the current creation time. Asked once; afterwards
	 * the key resolves normally again.
	 */
	async reaffirm(withheld: WithheldKey, scope: KeyScope): Promise<void> {
		if (!scope.workspaceKey) {
			return;
		}
		await this.registry.record(withheld.secretName, {
			providerId: withheld.providerId,
			hash: workspaceHash(scope.workspaceKey),
			label: pathLabel(scope.workspaceKey),
			birthtimeMs: await this.birthtime(scope.identityUri),
		});
		this.invalidate();
	}

	/** Every key this extension knows it stored, longest-unused first. */
	storedKeys(): StoredKey[] {
		return this.registry.list();
	}

	/**
	 * Deletes secrets by name, so entries whose workspace no longer exists can be
	 * removed — the path that produced their hash is unavailable by definition.
	 */
	async forget(names: readonly string[]): Promise<void> {
		for (const name of names) {
			await this.secrets.delete(name);
		}
		await this.registry.forget(names);
		this.invalidate();
	}

	async has(providerId: string, workspaceKey: string): Promise<boolean> {
		return (await this.secrets.get(this.secretNameFor(providerId, workspaceKey))) !== undefined;
	}
}
