import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderConfig } from '../types';
import { isResolvedKey } from '../types';
import { KeyRegistry, type RegistryStore } from '../auth/keyRegistry';
import { KeyResolver, type KeyScope } from '../auth/keyResolver';
import { type IdentitySource } from '../auth/workspaceIdentity';

class FakeStore implements RegistryStore {
	private values = new Map<string, unknown>();
	get<T>(key: string, defaultValue: T): T {
		return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
	}
	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

class FakeSecrets {
	readonly entries = new Map<string, string>();
	/** `get` calls, so the memo tests can count keychain roundtrips. */
	reads = 0;
	async get(key: string): Promise<string | undefined> {
		this.reads++;
		return this.entries.get(key);
	}
	async store(key: string, value: string): Promise<void> {
		this.entries.set(key, value);
	}
	async delete(key: string): Promise<void> {
		this.entries.delete(key);
	}
	// Unused by the resolver, but part of the interface.
	readonly onDidChange = () => ({ dispose: () => undefined });
}

const PROVIDER: ProviderConfig = { id: 'openai', baseUrl: 'https://api.example.com/v1' };
const WORKSPACE = 'file:///c%3A/workspace/kunde-a/portal';
const IDENTITY: IdentitySource = { scheme: 'file', fsPath: 'c:\\workspace\\kunde-a\\portal' };
const SCOPE: KeyScope = { workspaceKey: WORKSPACE, identityUri: IDENTITY };

/** Creation time the fake filesystem reports; reassigned per test. */
let birthtime: number | undefined;

let secrets: FakeSecrets;
let registry: KeyRegistry;
let keys: KeyResolver;

function build(): void {
	secrets = new FakeSecrets();
	registry = new KeyRegistry(new FakeStore(), () => 1_700_000_000_000);
	keys = new KeyResolver(secrets as never, registry, {}, async () => birthtime);
}

describe('stored key resolution', () => {
	beforeEach(() => {
		birthtime = 5_000_000;
		build();
	});

	test('stores a key and hands it back', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		const resolved = await keys.resolve(PROVIDER, SCOPE, 'user');
		assert.equal(isResolvedKey(resolved) && resolved.key, 'sk-stored');
		assert.equal(isResolvedKey(resolved) && resolved.source, 'secret');
	});

	test('the stored key is indexed, with the creation time it was stored against', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		const [entry] = keys.storedKeys();
		assert.equal(entry?.providerId, 'openai');
		assert.equal(entry?.label, 'kunde-a/portal');
		assert.equal(entry?.birthtimeMs, 5_000_000);
		assert.equal(entry?.name, keys.secretNameFor(PROVIDER.id, WORKSPACE));
	});

	test('withholds the key once the path points at a different directory', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);

		// Same path, folder recreated later: a new creation time.
		birthtime = 9_000_000;
		build2();

		const resolved = await keys.resolve(PROVIDER, SCOPE, 'user');
		assert.equal(isResolvedKey(resolved), false);
		assert.equal(resolved.withheld?.providerId, 'openai');
		assert.equal(resolved.withheld?.label, 'kunde-a/portal');
		assert.equal(resolved.withheld?.secretName, keys.secretNameFor(PROVIDER.id, WORKSPACE));
		assert.equal(secrets.entries.size, 1, 'the key is withheld, not deleted');
	});

	test('keeps handing out the key while the directory is the same one', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		build2();
		const resolved = await keys.resolve(PROVIDER, SCOPE, 'user');
		assert.equal(isResolvedKey(resolved) && resolved.key, 'sk-stored');
	});

	// The property that keeps an offline share or a remote scheme from looking
	// like a recycled path.
	test('keeps handing out the key when the filesystem reports no creation time', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		birthtime = undefined;
		build2();
		const resolved = await keys.resolve(PROVIDER, SCOPE, 'user');
		assert.equal(isResolvedKey(resolved) && resolved.key, 'sk-stored');
	});

	test('keeps handing out the key when it was stored without a creation time', async () => {
		birthtime = undefined;
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		birthtime = 9_000_000;
		build2();
		const resolved = await keys.resolve(PROVIDER, SCOPE, 'user');
		assert.equal(isResolvedKey(resolved) && resolved.key, 'sk-stored');
	});

	test('adopts a key that predates the index rather than withholding it', async () => {
		// A secret that exists in SecretStorage without an index entry, as after a
		// lost or reset globalState.
		await secrets.store(keys.secretNameFor(PROVIDER.id, WORKSPACE), 'sk-legacy');
		const resolved = await keys.resolve(PROVIDER, SCOPE, 'user');
		assert.equal(isResolvedKey(resolved) && resolved.key, 'sk-legacy');

		const [entry] = keys.storedKeys();
		assert.equal(entry?.adopted, true);
		assert.equal(entry?.birthtimeMs, 5_000_000);
	});

	test('re-confirming a withheld key makes it resolve again', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		birthtime = 9_000_000;
		build2();

		const withheld = (await keys.resolve(PROVIDER, SCOPE, 'user')).withheld;
		assert.ok(withheld);
		await keys.reaffirm(withheld, SCOPE);

		const resolved = await keys.resolve(PROVIDER, SCOPE, 'user');
		assert.equal(isResolvedKey(resolved) && resolved.key, 'sk-stored');
	});

	test('forget removes both the secret and its index entry', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		await keys.forget([keys.secretNameFor(PROVIDER.id, WORKSPACE)]);
		assert.equal(secrets.entries.size, 0);
		assert.deepEqual(keys.storedKeys(), []);
		assert.equal(isResolvedKey(await keys.resolve(PROVIDER, SCOPE, 'user')), false);
	});

	test('clear removes the key for the current workspace', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		await keys.clear(PROVIDER.id, WORKSPACE);
		assert.equal(secrets.entries.size, 0);
		assert.deepEqual(keys.storedKeys(), []);
	});

	test('a non-file scheme is never treated as recycled', async () => {
		const remote: KeyScope = { workspaceKey: WORKSPACE, identityUri: { scheme: 'vscode-vfs', fsPath: '/repo' } };
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', remote.identityUri);
		birthtime = 9_000_000;
		build2();
		const resolved = await keys.resolve(PROVIDER, remote, 'user');
		assert.equal(isResolvedKey(resolved) && resolved.key, 'sk-stored');
	});
});

describe('fallback tiers', () => {
	beforeEach(() => {
		birthtime = 5_000_000;
		build();
	});

	test('falls back to the configured key when nothing is stored', async () => {
		const resolved = await keys.resolve({ ...PROVIDER, apiKey: 'sk-literal' }, SCOPE, 'user');
		assert.equal(isResolvedKey(resolved) && resolved.source, 'plaintext');
	});

	test('reports an unset environment reference', async () => {
		const resolved = await keys.resolve({ ...PROVIDER, apiKey: '${env:ABSENT}' }, SCOPE, 'user');
		assert.equal(resolved.reason, 'missing-env');
		assert.deepEqual(resolved.envNames, ['ABSENT']);
		assert.equal(resolved.withheld, undefined);
	});

	test('a stored key wins over a configured one', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		const resolved = await keys.resolve({ ...PROVIDER, apiKey: 'sk-literal' }, SCOPE, 'user');
		assert.equal(isResolvedKey(resolved) && resolved.key, 'sk-stored');
	});

	test('a withheld key does not fall through to the configured one', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		birthtime = 9_000_000;
		build2();
		const resolved = await keys.resolve({ ...PROVIDER, apiKey: 'sk-literal' }, SCOPE, 'user');
		assert.equal(isResolvedKey(resolved), false);
		assert.ok(resolved.withheld);
	});

	test('with no workspace open only the configured key is available', async () => {
		const resolved = await keys.resolve(
			{ ...PROVIDER, apiKey: 'sk-literal' },
			{ workspaceKey: undefined, identityUri: undefined },
			'user',
		);
		assert.equal(isResolvedKey(resolved) && resolved.source, 'plaintext');
	});

	test('with nothing stored and nothing configured the reason is absent', async () => {
		const resolved = await keys.resolve(PROVIDER, SCOPE, 'user');
		assert.equal(isResolvedKey(resolved), false);
		assert.equal(resolved.reason, 'absent');
	});
});

describe('workspace-scoped env references', () => {
	beforeEach(() => {
		birthtime = 5_000_000;
		build();
	});

	// A `.vscode/settings.json` arrives with the repository; resolving its
	// `${env:NAME}` would hand any cloned repo the user's environment.
	test('a ${env:} reference from workspace settings is blocked even when the variable is set', async () => {
		const withEnv = new KeyResolver(secrets as never, registry, { GITHUB_TOKEN: 'ghp-secret' }, async () => birthtime);
		const resolved = await withEnv.resolve({ ...PROVIDER, apiKey: '${env:GITHUB_TOKEN}' }, SCOPE, 'workspace');
		assert.equal(isResolvedKey(resolved), false);
		assert.equal(resolved.reason, 'workspace-env-blocked');
		assert.deepEqual(resolved.envNames, ['GITHUB_TOKEN']);
	});

	test('the same reference from user settings resolves', async () => {
		const withEnv = new KeyResolver(secrets as never, registry, { GITHUB_TOKEN: 'ghp-secret' }, async () => birthtime);
		const resolved = await withEnv.resolve({ ...PROVIDER, apiKey: '${env:GITHUB_TOKEN}' }, SCOPE, 'user');
		assert.equal(isResolvedKey(resolved) && resolved.key, 'ghp-secret');
		assert.equal(isResolvedKey(resolved) && resolved.source, 'env');
	});

	test('a literal key from workspace settings keeps working', async () => {
		const resolved = await keys.resolve({ ...PROVIDER, apiKey: 'sk-repo-key' }, SCOPE, 'workspace');
		assert.equal(isResolvedKey(resolved) && resolved.key, 'sk-repo-key');
		assert.equal(isResolvedKey(resolved) && resolved.source, 'plaintext');
	});

	test('a stored key still wins over a blocked workspace reference', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		const resolved = await keys.resolve({ ...PROVIDER, apiKey: '${env:ANY}' }, SCOPE, 'workspace');
		assert.equal(isResolvedKey(resolved) && resolved.key, 'sk-stored');
	});
});

describe('resolution memo', () => {
	beforeEach(() => {
		birthtime = 5_000_000;
		build();
	});

	test('a second resolve does not hit SecretStorage again', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		const before = secrets.reads;
		await keys.resolve(PROVIDER, SCOPE, 'user');
		await keys.resolve(PROVIDER, SCOPE, 'user');
		assert.equal(secrets.reads, before + 1);
	});

	test('invalidate forces a fresh read', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		await keys.resolve(PROVIDER, SCOPE, 'user');
		const before = secrets.reads;
		keys.invalidate();
		await keys.resolve(PROVIDER, SCOPE, 'user');
		assert.equal(secrets.reads, before + 1);
	});

	test('storing a key invalidates a memoised failure', async () => {
		const missing = await keys.resolve(PROVIDER, SCOPE, 'user');
		assert.equal(isResolvedKey(missing), false);
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-fresh', IDENTITY);
		const resolved = await keys.resolve(PROVIDER, SCOPE, 'user');
		assert.equal(isResolvedKey(resolved) && resolved.key, 'sk-fresh');
	});

	test('forgetting a key invalidates a memoised success', async () => {
		await keys.store(PROVIDER.id, WORKSPACE, 'sk-stored', IDENTITY);
		assert.equal(isResolvedKey(await keys.resolve(PROVIDER, SCOPE, 'user')), true);
		await keys.forget([keys.secretNameFor(PROVIDER.id, WORKSPACE)]);
		assert.equal(isResolvedKey(await keys.resolve(PROVIDER, SCOPE, 'user')), false);
	});
});

/**
 * Rebuilds the resolver on the same secrets and index.
 *
 * Creation times are cached for the lifetime of a resolver — they cannot change
 * while a path keeps pointing at the same directory — so simulating "the folder
 * was recreated between sessions" means starting a new resolver, exactly as
 * reopening the window would.
 */
function build2(): void {
	keys = new KeyResolver(secrets as never, registry, {}, async () => birthtime);
}
