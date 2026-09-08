import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BIRTHTIME_TOLERANCE_MS, INDEX_KEY, KeyRegistry, type RegistryStore, isRecycled, pathLabel } from '../auth/keyRegistry';

/** Stands in for `context.globalState`. */
class FakeStore implements RegistryStore {
	private values = new Map<string, unknown>();
	writes = 0;

	get<T>(key: string, defaultValue: T): T {
		return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.writes++;
		this.values.set(key, value);
	}

	raw(): Record<string, unknown> {
		return (this.values.get(INDEX_KEY) as Record<string, unknown>) ?? {};
	}
}

const DAY = 24 * 60 * 60 * 1_000;
const INPUT = { providerId: 'openai', hash: 'abc123', label: 'work/portal', birthtimeMs: 1_700_000_000_000 };

describe('pathLabel', () => {
	test('keeps the last two segments of a Windows path', () => {
		assert.equal(pathLabel('file:///c%3A/workspace/kunde-a/portal'), 'kunde-a/portal');
	});

	test('keeps the last two segments of a POSIX path', () => {
		assert.equal(pathLabel('file:///home/joel/projects/scratch'), 'projects/scratch');
	});

	test('keeps a .code-workspace file name', () => {
		assert.equal(pathLabel('file:///c%3A/work/team.code-workspace'), 'work/team.code-workspace');
	});

	test('handles a single segment', () => {
		assert.equal(pathLabel('file:///root'), 'root');
	});

	test('falls back to the input when there is no path', () => {
		assert.equal(pathLabel('untitled:Untitled-1'), 'Untitled-1');
		assert.equal(pathLabel('not a uri at all'), 'not a uri at all');
	});

	test('does not leak the full path', () => {
		assert.equal(pathLabel('file:///c%3A/secret-customer/deep/nested/repo'), 'nested/repo');
	});
});

describe('isRecycled', () => {
	const record = { providerId: 'p', hash: 'h', label: 'l', storedAt: 0, birthtimeMs: 1_000_000 };

	test('is false for the same creation time', () => {
		assert.equal(isRecycled(record, 1_000_000), false);
	});

	test('tolerates filesystem rounding', () => {
		assert.equal(isRecycled(record, 1_000_000 + BIRTHTIME_TOLERANCE_MS), false);
		assert.equal(isRecycled(record, 1_000_000 - BIRTHTIME_TOLERANCE_MS), false);
	});

	test('is true beyond the tolerance, in either direction', () => {
		assert.equal(isRecycled(record, 1_000_000 + BIRTHTIME_TOLERANCE_MS + 1), true);
		assert.equal(isRecycled(record, 1_000_000 - BIRTHTIME_TOLERANCE_MS - 1), true);
	});

	// The safety property: an offline share, a remote scheme or a filesystem
	// without birthtime must never cause a working key to be withheld.
	test('is false when the current creation time is unknown', () => {
		assert.equal(isRecycled(record, undefined), false);
	});

	test('is false when the record has no creation time', () => {
		assert.equal(isRecycled({ ...record, birthtimeMs: undefined }, 1_000_000), false);
	});
});

describe('KeyRegistry', () => {
	let store: FakeStore;
	let now: number;
	let registry: KeyRegistry;

	beforeEach(() => {
		store = new FakeStore();
		now = 1_000 * DAY;
		registry = new KeyRegistry(store, () => now);
	});

	test('records and reads back an entry', async () => {
		await registry.record('workspace-keys:openai:abc123', INPUT);
		const record = registry.get('workspace-keys:openai:abc123');
		assert.equal(record?.providerId, 'openai');
		assert.equal(record?.label, 'work/portal');
		assert.equal(record?.birthtimeMs, INPUT.birthtimeMs);
		assert.equal(record?.storedAt, now);
		assert.equal(record?.adopted, undefined);
	});

	test('omits the creation time when the filesystem reported none', async () => {
		await registry.record('workspace-keys:openai:abc123', { ...INPUT, birthtimeMs: undefined });
		assert.equal('birthtimeMs' in (registry.get('workspace-keys:openai:abc123') ?? {}), false);
	});

	test('keeps the original storedAt when a key is re-recorded', async () => {
		await registry.record('n', INPUT);
		now += 30 * DAY;
		await registry.record('n', { ...INPUT, birthtimeMs: 999 });
		const record = registry.get('n');
		assert.equal(record?.storedAt, 1_000 * DAY);
		assert.equal(record?.lastUsedAt, 1_030 * DAY);
		assert.equal(record?.birthtimeMs, 999);
	});

	test('marks an adopted entry and does not overwrite an existing one', async () => {
		await registry.adopt('n', INPUT);
		assert.equal(registry.get('n')?.adopted, true);

		await registry.adopt('n', { ...INPUT, label: 'other/place' });
		assert.equal(registry.get('n')?.label, 'work/portal');
	});

	test('forgets entries by name and leaves the others alone', async () => {
		await registry.record('a', INPUT);
		await registry.record('b', { ...INPUT, providerId: 'azure' });
		await registry.forget(['a', 'does-not-exist']);
		assert.deepEqual(
			registry.list().map((entry) => entry.name),
			['b'],
		);
	});

	test('does not write when there is nothing to forget', async () => {
		await registry.record('a', INPUT);
		const before = store.writes;
		await registry.forget(['nope']);
		assert.equal(store.writes, before);
	});

	test('lists longest-unused first', async () => {
		await registry.record('old', INPUT);
		now += 10 * DAY;
		await registry.record('recent', INPUT);
		assert.deepEqual(
			registry.list().map((entry) => entry.name),
			['old', 'recent'],
		);
	});

	test('touch is throttled so discovery does not write on every pass', async () => {
		await registry.record('n', INPUT);
		const before = store.writes;

		now += 60 * 60 * 1_000;
		await registry.touch('n');
		assert.equal(store.writes, before, 'an hour later is not worth a write');

		now += 2 * DAY;
		await registry.touch('n');
		assert.equal(store.writes, before + 1);
		assert.equal(registry.get('n')?.lastUsedAt, now);
	});

	test('touch ignores an unknown name', async () => {
		await registry.touch('nothing-here');
		assert.equal(store.writes, 0);
	});

	test('skips malformed entries instead of failing', async () => {
		await store.update(INDEX_KEY, { broken: null, alsoBroken: 'a string', good: { ...INPUT, storedAt: now } });
		assert.equal(registry.count(), 1);
		assert.equal(registry.get('broken'), undefined);
		assert.equal(registry.get('alsoBroken'), undefined);
		assert.equal(registry.get('good')?.providerId, 'openai');
	});
});
