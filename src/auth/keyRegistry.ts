/**
 * Bookkeeping for the keys this extension has stored.
 *
 * `vscode.SecretStorage` cannot enumerate its contents, so a key whose
 * workspace is gone can neither be listed nor deleted: its name is a hash of a
 * path that no longer exists. This index is the missing directory. It records
 * one entry per stored key so they stay visible and removable, and it remembers
 * the creation time of the workspace a key was stored for so that a new folder
 * at a recycled path cannot silently inherit the previous project's key.
 *
 * Kept free of a `vscode` import so the logic stays testable with plain
 * `node --test` — the store is injected as a narrow interface that
 * `context.globalState` happens to satisfy.
 */

/** Written to `globalState` under this key. */
export const INDEX_KEY = 'workspaceKeys.storedKeys';

/**
 * Filesystem creation times are not exact across filesystems — FAT/exFAT round
 * to two seconds, and network shares round in their own ways. Only a difference
 * beyond that counts as "a different directory".
 */
export const BIRTHTIME_TOLERANCE_MS = 2_000;

/** How stale `lastUsedAt` may get before it is written again. Keeps discovery off the disk. */
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** The slice of `vscode.Memento` this needs. */
export interface RegistryStore {
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Thenable<void>;
}

export interface KeyRecord {
	/** Provider the key belongs to — one half of the SecretStorage name. */
	providerId: string;
	/** Workspace hash — the other half. */
	hash: string;
	/**
	 * The last two path segments of the workspace, enough to recognise it in a
	 * list. Deliberately not the full path: `globalState` is not encrypted, and a
	 * complete list of project paths is more than this needs to do its job.
	 */
	label: string;
	/** When the key was first recorded, epoch ms. */
	storedAt: number;
	/** When it was last handed out, epoch ms. */
	lastUsedAt?: number;
	/**
	 * Creation time of the folder (or `.code-workspace` file) the key belongs to.
	 * Undefined when the filesystem reported none — see `birthtimeOf`.
	 */
	birthtimeMs?: number;
	/** True when the entry was inferred from an existing secret rather than written on store. */
	adopted?: boolean;
}

export interface StoredKey extends KeyRecord {
	/** The SecretStorage name, so an entry can be deleted without knowing its workspace. */
	name: string;
}

export interface RecordInput {
	providerId: string;
	hash: string;
	label: string;
	birthtimeMs: number | undefined;
}

/**
 * Whether a record describes a different directory than the one now at the path.
 *
 * Returns false whenever either side has no creation time. That is the whole
 * safety property: an unmounted share, a remote scheme or a filesystem without
 * birthtime must leave a working key alone rather than have it withheld.
 */
export function isRecycled(record: KeyRecord, currentBirthtimeMs: number | undefined): boolean {
	if (record.birthtimeMs === undefined || currentBirthtimeMs === undefined) {
		return false;
	}
	return Math.abs(record.birthtimeMs - currentBirthtimeMs) > BIRTHTIME_TOLERANCE_MS;
}

/**
 * Shortens a workspace URI to its last two path segments,
 * e.g. `file:///c%3A/work/kunde-a/portal` → `kunde-a/portal`.
 */
export function pathLabel(workspaceKey: string): string {
	let path = workspaceKey;
	try {
		path = decodeURIComponent(new URL(workspaceKey).pathname);
	} catch {
		// Not a URI, or an undecodable escape — fall back to the raw string.
	}
	const segments = path.split(/[/\\]/).filter((segment) => segment.length > 0);
	return segments.slice(-2).join('/') || workspaceKey;
}

export class KeyRegistry {
	constructor(
		private readonly store: RegistryStore,
		private readonly now: () => number = Date.now,
	) {}

	private all(): Record<string, KeyRecord> {
		const raw = this.store.get<Record<string, KeyRecord>>(INDEX_KEY, {});
		return raw && typeof raw === 'object' ? raw : {};
	}

	get(name: string): KeyRecord | undefined {
		const record = this.all()[name];
		return record && typeof record.providerId === 'string' ? record : undefined;
	}

	/** Longest-unused first, which is the order a cleanup wants to work through. */
	list(): StoredKey[] {
		return Object.entries(this.all())
			.filter(([, record]) => record && typeof record.providerId === 'string')
			.map(([name, record]) => ({ ...record, name }))
			.sort((a, b) => (a.lastUsedAt ?? a.storedAt) - (b.lastUsedAt ?? b.storedAt));
	}

	count(): number {
		return this.list().length;
	}

	/** Called when a key is written, and on re-confirmation of a recycled path. */
	async record(name: string, input: RecordInput): Promise<void> {
		const existing = this.get(name);
		await this.write(name, {
			providerId: input.providerId,
			hash: input.hash,
			label: input.label,
			storedAt: existing?.storedAt ?? this.now(),
			lastUsedAt: this.now(),
			...(input.birthtimeMs !== undefined ? { birthtimeMs: input.birthtimeMs } : {}),
		});
	}

	/**
	 * Registers a secret that exists without an entry — a key stored before this
	 * index did. Adopting it rather than treating it as recycled is the only
	 * option that does not withhold every pre-existing key exactly once.
	 */
	async adopt(name: string, input: RecordInput): Promise<void> {
		if (this.get(name)) {
			return;
		}
		await this.write(name, {
			providerId: input.providerId,
			hash: input.hash,
			label: input.label,
			storedAt: this.now(),
			lastUsedAt: this.now(),
			adopted: true,
			...(input.birthtimeMs !== undefined ? { birthtimeMs: input.birthtimeMs } : {}),
		});
	}

	/** Records use, at most once per `TOUCH_INTERVAL_MS`, so discovery does not write on every pass. */
	async touch(name: string): Promise<void> {
		const record = this.get(name);
		if (!record) {
			return;
		}
		const now = this.now();
		if (record.lastUsedAt !== undefined && now - record.lastUsedAt < TOUCH_INTERVAL_MS) {
			return;
		}
		await this.write(name, { ...record, lastUsedAt: now });
	}

	async forget(names: readonly string[]): Promise<void> {
		const remaining = this.all();
		let changed = false;
		for (const name of names) {
			if (name in remaining) {
				delete remaining[name];
				changed = true;
			}
		}
		if (changed) {
			await this.store.update(INDEX_KEY, remaining);
		}
	}

	private async write(name: string, record: KeyRecord): Promise<void> {
		await this.store.update(INDEX_KEY, { ...this.all(), [name]: record });
	}
}
