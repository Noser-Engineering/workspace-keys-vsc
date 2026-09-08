import * as vscode from 'vscode';

export interface Debounced extends vscode.Disposable {
	trigger(): void;
}

/**
 * Coalesces refresh triggers.
 *
 * Several events routinely fire together — saving `.vscode/settings.json` emits
 * a configuration change per affected key — and each one would otherwise rebuild
 * the model list.
 */
export function debounce(action: () => void, delayMs: number): Debounced {
	let timer: NodeJS.Timeout | undefined;
	return {
		trigger() {
			if (timer) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => {
				timer = undefined;
				action();
			}, delayMs);
		},
		dispose() {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
	};
}
