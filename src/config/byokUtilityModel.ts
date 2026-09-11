const INITIALIZED_KEY = 'byokUtilityModelInitialized';

export interface InitializationState {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

export async function initializeByokUtilityModel(
	state: InitializationState,
	globalValue: string | undefined,
	setGlobalValue: () => PromiseLike<void>,
): Promise<void> {
	if (state.get<boolean>(INITIALIZED_KEY)) {
		return;
	}
	if (globalValue === undefined) {
		await setGlobalValue();
	}
	await state.update(INITIALIZED_KEY, true);
}
