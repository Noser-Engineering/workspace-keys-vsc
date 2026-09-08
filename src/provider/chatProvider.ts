import * as vscode from 'vscode';
import type { ProviderConfig, WithheldKey } from '../types';
import { isResolvedKey } from '../types';
import { ConfigReader, type ProviderOrigin, type WorkspaceScope } from '../config/workspaceConfig';
import { type HideReason, hideReason, resolveCapabilities, ruleChain } from '../config/modelRules';
import { KeyResolver } from '../auth/keyResolver';
import { BaseUrlConsent } from '../security/baseUrlConsent';
import { ModelCatalog } from './models';
import { abortOn, buildHeaders, endpoint, toHttpError } from './http';
import { buildRequestBody } from './request';
import { ChatCompletionAccumulator, SseDecoder, StreamEvent, eventsFromCompletion } from './stream';
import { composeModelId, splitModelId } from './modelId';
import { estimateImageTokens, estimateTokens } from './tokenEstimate';
import { CancelledError, withRetry } from '../util/backoff';
import { log, redactHeaders, scrubSecret } from '../util/log';

export interface ActiveScopeDescription {
	/** False in an untrusted workspace, where nothing is read and nothing is sent. */
	trusted: boolean;
	folderName: string | undefined;
	/**
	 * Title of the provider the status bar speaks for: the first one that
	 * contributes models, otherwise the first one configured. Undefined when no
	 * provider is configured at all.
	 */
	activeProviderTitle: string | undefined;
	providerCount: number;
	modelCount: number;
	/** Providers that are configured but have no key for this workspace yet. */
	needsKey: number;
	/** Providers whose stored key is being withheld because the path was reused. */
	withheld: number;
	needsApproval: number;
	failed: number;
}

/**
 * Why a provider contributed what it did.
 *
 * "no key for this workspace" is an expected state, not a fault: the provider
 * is typically defined once in user settings and each workspace supplies its
 * own key. The status bar has to tell the two apart to avoid warning about
 * every workspace a key has simply not been set for yet.
 */
type ProviderStatus = 'ok' | 'no-key' | 'key-withheld' | 'not-approved' | 'all-hidden' | 'error';

interface ProviderOutcome {
	models: vscode.LanguageModelChatInformation[];
	status: ProviderStatus;
}

export class WorkspaceKeysChatProvider implements vscode.LanguageModelChatProvider {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

	private readonly scopeEmitter = new vscode.EventEmitter<ActiveScopeDescription>();
	/** Fires after each discovery pass so the status bar can describe the active scope. */
	readonly onDidDescribeScope = this.scopeEmitter.event;

	private keyNoticeShownFor = new Set<string>();

	constructor(
		private readonly config: ConfigReader,
		private readonly keys: KeyResolver,
		private readonly consent: BaseUrlConsent,
		private readonly catalog: ModelCatalog,
	) {}

	dispose(): void {
		this.changeEmitter.dispose();
		this.scopeEmitter.dispose();
	}

	/** Drops caches and asks VS Code to re-query the model list. No window reload needed. */
	refresh(): void {
		this.catalog.invalidate();
		this.keys.invalidate();
		this.keyNoticeShownFor.clear();
		this.changeEmitter.fire();
	}

	async provideLanguageModelChatInformation(
		options: { readonly silent: boolean },
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (!vscode.workspace.isTrusted) {
			log().info('Workspace is not trusted; contributing no models and making no network requests.');
			this.scopeEmitter.fire({
				trusted: false,
				folderName: undefined,
				activeProviderTitle: undefined,
				providerCount: 0,
				modelCount: 0,
				needsKey: 0,
				withheld: 0,
				needsApproval: 0,
				failed: 0,
			});
			return [];
		}

		const scope = this.config.currentScope();
		const { providers, problems, origin } = this.config.readProviders(scope.folder);
		for (const problem of problems) {
			log().warn(problem);
		}

		const rules = ruleChain(this.config.readModelRules());
		const hideUnknown = this.config.hideUnknownModels();

		// One misconfigured provider must not remove every other provider's models,
		// so each is isolated rather than sharing a single Promise.all rejection.
		const perProvider = await Promise.all(
			providers.map(async (provider) => {
				try {
					return await this.modelsFor(provider, scope, rules, hideUnknown, options.silent, origin, token);
				} catch (error) {
					log().error(`Provider "${provider.id}" could not be resolved: ${describe(error, undefined)}`);
					return { models: [], status: 'error' as const };
				}
			}),
		);
		const models = perProvider.flatMap((outcome) => outcome.models);
		const countOf = (status: ProviderStatus) => perProvider.filter((outcome) => outcome.status === status).length;

		// The status bar speaks for one provider, and the one that actually
		// contributes models is the one a user is working with.
		const contributing = providers.find((_, index) => perProvider[index].models.length > 0);
		const active = contributing ?? providers[0];

		this.scopeEmitter.fire({
			trusted: true,
			folderName: scope.folder?.name,
			activeProviderTitle: active ? titleOf(active) : undefined,
			providerCount: providers.length,
			modelCount: models.length,
			needsKey: countOf('no-key'),
			withheld: countOf('key-withheld'),
			needsApproval: countOf('not-approved'),
			failed: countOf('error') + countOf('all-hidden'),
		});
		return models;
	}

	private async modelsFor(
		provider: ProviderConfig,
		scope: WorkspaceScope,
		rules: ReturnType<typeof ruleChain>,
		hideUnknown: boolean,
		silent: boolean,
		origin: ProviderOrigin,
		token: vscode.CancellationToken,
	): Promise<ProviderOutcome> {
		const label = titleOf(provider);

		const key = await this.keys.resolve(provider, scope, origin);
		if (!isResolvedKey(key)) {
			// A withheld key is a decision waiting to be made, not a missing key:
			// offering "Set API Key" here would quietly overwrite a key that may
			// well be the right one.
			if (key.withheld) {
				log().warn(
					`Withholding the stored key for provider "${provider.id}": it was stored on ` +
						`${new Date(key.withheld.storedAt).toISOString()} for a different directory at this path.`,
				);
				if (!silent) {
					this.noticeWithheldKey(provider, key.withheld, scope);
				}
				return { models: [], status: 'key-withheld' };
			}
			const reason = describeKeyFailure(key);
			if (key.reason === 'workspace-env-blocked') {
				log().warn(`Provider "${provider.id}": ${reason}.`);
			} else {
				log().info(`Provider "${provider.id}" has no usable API key (${reason}).`);
			}
			if (!silent) {
				this.noticeMissingKey(provider, reason);
			}
			return { models: [], status: 'no-key' };
		}

		if (!(await this.consent.ensure(provider.baseUrl, label, silent, origin))) {
			log().warn(
				`Provider "${provider.id}" contributes no models: the endpoint ${provider.baseUrl} is not approved yet. ` +
					'Open the model picker, or click the Workspace Keys status bar item, to approve it.',
			);
			return { models: [], status: 'not-approved' };
		}

		let modelIds: string[];
		try {
			modelIds = await this.catalog.list(provider, key.key, token);
		} catch (error) {
			log().error(`Model discovery failed for provider "${provider.id}": ${describe(error, key.key)}`);
			return { models: [], status: 'error' };
		}

		const information: vscode.LanguageModelChatInformation[] = [];
		const hidden: Record<HideReason, string[]> = { rule: [], unknown: [] };

		for (const modelId of modelIds) {
			const capabilities = resolveCapabilities(modelId, rules);
			const reason = hideReason(capabilities, hideUnknown);
			if (reason) {
				hidden[reason].push(modelId);
				continue;
			}
			information.push({
				id: composeModelId(provider.id, modelId),
				name: modelId,
				family: provider.id,
				version: '1.0.0',
				detail: label,
				tooltip: `${modelId} via ${label} (${provider.baseUrl})`,
				maxInputTokens: capabilities.maxInputTokens,
				maxOutputTokens: capabilities.maxOutputTokens,
				capabilities: {
					toolCalling: capabilities.toolCalling,
					imageInput: capabilities.imageInput,
				},
			});
		}

		log().info(
			`Provider "${provider.id}": ${modelIds.length} model(s) reported, ${information.length} offered, ` +
				`${hidden.unknown.length} hidden as unknown, ${hidden.rule.length} hidden by a rule.`,
		);
		if (information.length === 0 && modelIds.length > 0) {
			// The most common "it finds nothing" case: a private gateway whose model
			// names match none of the built-in globs, with hideUnknownModels on.
			if (hidden.unknown.length > 0) {
				log().warn(
					`No model of "${provider.id}" matches any rule, so all were hidden: ${hidden.unknown.slice(0, 10).join(', ')}` +
						`${hidden.unknown.length > 10 ? ', …' : ''}. Add a workspaceKeys.modelRules entry for them, ` +
						'or set workspaceKeys.hideUnknownModels to false.',
				);
			}
			if (hidden.rule.length > 0) {
				log().warn(`Hidden by an explicit rule: ${hidden.rule.slice(0, 10).join(', ')}.`);
			}
		}
		return {
			models: information,
			status: information.length === 0 && modelIds.length > 0 ? 'all-hidden' : 'ok',
		};
	}

	/**
	 * Asks once whether a key stored for an earlier directory at this path applies
	 * to the one that is here now.
	 *
	 * Recreating a folder at a path a key was stored for is legitimate — a fresh
	 * clone of the same repository, most obviously — so the answer cannot be
	 * assumed either way. It can only be asked, and only once: "Use It Anyway"
	 * re-records the key against the current directory and the question is over.
	 */
	private noticeWithheldKey(provider: ProviderConfig, withheld: WithheldKey, scope: WorkspaceScope): void {
		if (this.keyNoticeShownFor.has(provider.id)) {
			return;
		}
		this.keyNoticeShownFor.add(provider.id);
		const storedOn = new Date(withheld.storedAt).toLocaleDateString();
		void vscode.window
			.showWarningMessage(
				`Workspace Keys: the key for "${provider.id}" was stored on ${storedOn} for an earlier folder at this path, ` +
					'and is being withheld until you confirm it.',
				'Use It Anyway',
				'Delete Key',
				'Set New Key',
			)
			.then(async (choice) => {
				if (choice === 'Use It Anyway') {
					await this.keys.reaffirm(withheld, scope);
					log().info(`The stored key for provider "${provider.id}" was re-confirmed for this workspace.`);
				} else if (choice === 'Delete Key') {
					await this.keys.forget([withheld.secretName]);
					log().info(`Deleted the withheld key for provider "${provider.id}".`);
				} else if (choice === 'Set New Key') {
					await vscode.commands.executeCommand('workspaceKeys.setWorkspaceKey', provider.id);
					return;
				} else {
					return;
				}
				// The index has no change event of its own, so the refresh is explicit.
				this.refresh();
			})
			.then(undefined, (error: unknown) =>
				log().error(`Acting on the withheld-key notice failed: ${error instanceof Error ? error.message : String(error)}`),
			);
	}

	private noticeMissingKey(provider: ProviderConfig, reason: string): void {
		if (this.keyNoticeShownFor.has(provider.id)) {
			return;
		}
		this.keyNoticeShownFor.add(provider.id);
		// Not awaited: the model picker must not block on a notification. Storing a
		// key fires SecretStorage.onDidChange, which refreshes the list anyway.
		void vscode.window
			.showInformationMessage(`Workspace Keys: provider "${provider.id}" has no API key (${reason}).`, 'Set API Key')
			.then((choice) => {
				if (choice === 'Set API Key') {
					void vscode.commands.executeCommand('workspaceKeys.setWorkspaceKey', provider.id);
				}
			});
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		if (!vscode.workspace.isTrusted) {
			throw new Error('Workspace Keys: disabled in untrusted workspaces.');
		}

		const split = splitModelId(model.id);
		if (!split) {
			throw new Error(`Unrecognised model id "${model.id}".`);
		}

		const scope = this.config.currentScope();
		const { providers, origin } = this.config.readProviders(scope.folder);
		const provider = providers.find((candidate) => candidate.id === split.providerId);
		if (!provider) {
			throw new Error(
				`Provider "${split.providerId}" is not configured for this workspace folder${scope.folder ? ` (${scope.folder.name})` : ''}.`,
			);
		}

		if (!this.consent.isApproved(provider.baseUrl, origin)) {
			throw new Error(`Endpoint ${provider.baseUrl} has not been approved for this machine.`);
		}

		const key = await this.keys.resolve(provider, scope, origin);
		if (!isResolvedKey(key)) {
			throw new Error(
				key.withheld
					? `The stored key for provider "${provider.id}" was saved for an earlier folder at this path and is withheld. ` +
							'Open the model picker to confirm or replace it.'
					: `No API key available for provider "${provider.id}" (${describeKeyFailure(key)}).`,
			);
		}

		const { body, droppedModelOptions } = buildRequestBody({
			modelId: split.modelId,
			messages,
			options,
			defaults: this.config.readRequestDefaults(scope.folder),
			maxOutputTokens: model.maxOutputTokens,
		});
		if (droppedModelOptions.length > 0) {
			log().debug(`Dropped caller model options not accepted by OpenAI endpoints: ${droppedModelOptions.join(', ')}`);
		}
		const headers = buildHeaders(provider, key.key);
		const url = endpoint(provider, 'chat/completions');

		log().debug(`POST ${url} model=${split.modelId} headers=${JSON.stringify(redactHeaders(headers))}`);

		const { signal, dispose } = abortOn(token);
		try {
			// Only the connection is retried. Once parts have been reported to
			// `progress`, replaying the request would duplicate visible output.
			const response = await withRetry(
				async () => {
					const result = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
					if (!result.ok) {
						throw await toHttpError(result, key.key);
					}
					return result;
				},
				{
					token,
					onRetry: (attempt, delay, reason) =>
						log().warn(`Request to "${provider.id}" failed (attempt ${attempt}), retrying in ${delay} ms: ${reason}`),
				},
			);

			await this.consume(response, progress, token, key.key);
		} catch (error) {
			if (isAbort(error) || token.isCancellationRequested) {
				log().debug('Request cancelled.');
				return;
			}
			throw new Error(describe(error, key.key));
		} finally {
			dispose();
		}
	}

	private async consume(
		response: Response,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
		apiKey: string,
	): Promise<void> {
		const report = (event: StreamEvent) => {
			if (event.type === 'text') {
				progress.report(new vscode.LanguageModelTextPart(event.value));
			} else {
				progress.report(new vscode.LanguageModelToolCallPart(event.callId, event.name, event.input));
			}
		};

		const contentType = response.headers.get('content-type') ?? '';
		if (!contentType.includes('text/event-stream')) {
			// Some OpenAI-compatible servers ignore `stream: true`.
			log().debug(`Provider answered with "${contentType}"; falling back to a non-streamed body.`);
			const payload = await response.json();
			for (const event of eventsFromCompletion(payload)) {
				report(event);
			}
			return;
		}

		if (!response.body) {
			throw new Error('Provider returned an event stream without a body.');
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		const sse = new SseDecoder();
		const accumulator = new ChatCompletionAccumulator();

		try {
			for (;;) {
				if (token.isCancellationRequested) {
					await reader.cancel().catch(() => undefined);
					return;
				}
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				for (const payload of sse.push(decoder.decode(value, { stream: true }))) {
					for (const event of accumulator.handle(payload)) {
						report(event);
					}
				}
			}

			for (const payload of sse.flush()) {
				for (const event of accumulator.handle(payload)) {
					report(event);
				}
			}
			for (const event of accumulator.finish()) {
				report(event);
			}
		} catch (error) {
			if (isAbort(error) || token.isCancellationRequested) {
				return;
			}
			throw new Error(scrubSecret(error instanceof Error ? error.message : String(error), apiKey));
		} finally {
			reader.releaseLock?.();
		}
	}

	/** Estimation strategy and its bias live in `tokenEstimate.ts`. */
	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		return typeof text === 'string' ? estimateTokens(text) : tokensOfMessage(text);
	}
}

/** The user-facing title of a provider; the id is only the fallback. */
function titleOf(provider: ProviderConfig): string {
	return provider.label ?? provider.id;
}

function tokensOfMessage(message: vscode.LanguageModelChatRequestMessage): number {
	let tokens = 0;
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			tokens += estimateTokens(part.value);
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			tokens += estimateTokens(part.name) + estimateTokens(JSON.stringify(part.input ?? {}));
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			tokens += estimateTokens(JSON.stringify(part.content ?? []));
		} else if (part instanceof vscode.LanguageModelDataPart) {
			// UTF-8 runs ~3 bytes per token for ASCII (3 chars) and CJK (1 char) alike.
			tokens += part.mimeType.startsWith('image/') ? estimateImageTokens() : Math.ceil(part.data.byteLength / 3);
		}
	}
	return tokens;
}

function describeKeyFailure(failure: { reason: string; envNames: string[] }): string {
	switch (failure.reason) {
		case 'missing-env':
			return `environment variable(s) not set: ${failure.envNames.join(', ')}`;
		case 'workspace-env-blocked':
			return (
				`\${env:${failure.envNames.join(', ')}} comes from workspace settings and is not resolved there — ` +
				'a repository must not be able to read your environment. Declare the provider in your user settings instead'
			);
		default:
			return 'no key in SecretStorage and none configured';
	}
}

function isAbort(error: unknown): boolean {
	return (
		error instanceof CancelledError || (error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted')))
	);
}

function describe(error: unknown, apiKey: string | undefined): string {
	const message = error instanceof Error ? error.message : String(error);
	return scrubSecret(message, apiKey);
}
