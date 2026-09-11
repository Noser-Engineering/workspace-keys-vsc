import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeByokUtilityModel, type InitializationState } from '../config/byokUtilityModel';

class FakeState implements InitializationState {
	private readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

describe('initializeByokUtilityModel', () => {
	test('sets the global default on first installation', async () => {
		const state = new FakeState();
		let writes = 0;

		await initializeByokUtilityModel(state, undefined, async () => {
			writes++;
		});

		assert.equal(writes, 1);
	});

	test('preserves an existing global default', async () => {
		const state = new FakeState();
		let writes = 0;

		await initializeByokUtilityModel(state, 'customModel', async () => {
			writes++;
		});

		assert.equal(writes, 0);
	});

	test('does not set the default again after initialization', async () => {
		const state = new FakeState();
		let writes = 0;
		const setGlobalValue = async (): Promise<void> => {
			writes++;
		};

		await initializeByokUtilityModel(state, undefined, setGlobalValue);
		await initializeByokUtilityModel(state, undefined, setGlobalValue);

		assert.equal(writes, 1);
	});
});
