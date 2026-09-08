import * as vscode from 'vscode';
import type { ProviderOrigin } from '../config/workspaceConfig';
import { isEndpointApproved, originOf } from './approvalPolicy';
import { log } from '../util/log';

export { originOf } from './approvalPolicy';

const STATE_KEY = 'workspaceKeys.approvedOrigins';

/**
 * Consent gate for provider endpoints.
 *
 * `baseUrl` comes from workspace settings, so a cloned repository can choose it.
 * Consent is therefore asked once per origin and re-asked when the origin
 * changes. The gate sits in model discovery rather than in the request path, so
 * it never interrupts an in-flight chat request: an unapproved provider simply
 * contributes no models until it is approved.
 */
export class BaseUrlConsent {
	private readonly pending = new Map<string, Promise<boolean>>();

	constructor(private readonly context: vscode.ExtensionContext) {}

	private approved(): string[] {
		return this.context.globalState.get<string[]>(STATE_KEY, []);
	}

	/** The decision itself lives in `approvalPolicy.ts`; this only supplies the state. */
	isApproved(baseUrl: string, providerOrigin: ProviderOrigin = 'workspace'): boolean {
		return isEndpointApproved(baseUrl, providerOrigin, this.approved());
	}

	async ensure(baseUrl: string, providerLabel: string, silent: boolean, providerOrigin: ProviderOrigin = 'workspace'): Promise<boolean> {
		if (this.isApproved(baseUrl, providerOrigin)) {
			return true;
		}
		const origin = originOf(baseUrl);
		if (!origin || silent) {
			return false;
		}

		// Discovery can run concurrently for several providers sharing an origin.
		const inFlight = this.pending.get(origin);
		if (inFlight) {
			return inFlight;
		}

		const prompt = this.prompt(origin, providerLabel).finally(() => this.pending.delete(origin));
		this.pending.set(origin, prompt);
		return prompt;
	}

	/**
	 * Records an approval the caller has already obtained.
	 *
	 * Used by the key dialog, which shows the full base URL before a key is even
	 * entered; routing that through `ensure` would ask a second time for a
	 * decision the user has just made.
	 */
	async approve(baseUrl: string): Promise<boolean> {
		const origin = originOf(baseUrl);
		if (!origin) {
			return false;
		}
		await this.context.globalState.update(STATE_KEY, [...new Set([...this.approved(), origin])]);
		log().info(`Endpoint ${origin} approved.`);
		return true;
	}

	private async prompt(origin: string, providerLabel: string): Promise<boolean> {
		const choice = await vscode.window.showWarningMessage(
			`Send chat requests from this workspace to ${origin}?`,
			{
				modal: false,
				detail: `Provider "${providerLabel}" is configured in workspace settings. Approve it only if you trust this endpoint with the content of your prompts.`,
			},
			'Allow',
			'Not now',
		);
		if (choice !== 'Allow') {
			log().info(`Endpoint ${origin} was not approved.`);
			return false;
		}
		await this.context.globalState.update(STATE_KEY, [...new Set([...this.approved(), origin])]);
		log().info(`Endpoint ${origin} approved.`);
		return true;
	}

	async revoke(origin: string): Promise<void> {
		await this.context.globalState.update(
			STATE_KEY,
			this.approved().filter((entry) => entry !== origin),
		);
	}

	async revokeAll(): Promise<void> {
		await this.context.globalState.update(STATE_KEY, []);
	}

	list(): string[] {
		return this.approved();
	}
}
