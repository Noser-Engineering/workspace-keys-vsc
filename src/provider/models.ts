import * as vscode from 'vscode';
import type { ModelRule, ProviderConfig } from '../types';
import { abortOn, buildHeaders, endpoint, toHttpError } from './http';
import { modelInfoRules } from './modelInfo';
import { withRetry } from '../util/backoff';
import { log, scrubSecret } from '../util/log';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
	models: DiscoveredModels;
	expires: number;
}

export interface DiscoveredModels {
	ids: string[];
	infoRules: Map<string, ModelRule>;
}

/**
 * Model discovery with a short-lived cache.
 *
 * VS Code calls `provideLanguageModelChatInformation` frequently, including
 * silently in the background, so an uncached implementation would hit
 * `/models` on every picker interaction.
 */
export class ModelCatalog {
	private readonly cache = new Map<string, CacheEntry>();

	invalidate(): void {
		this.cache.clear();
	}

	async list(provider: ProviderConfig, apiKey: string, token: vscode.CancellationToken, readInfo: boolean): Promise<DiscoveredModels> {
		if (provider.models && provider.models.length > 0) {
			return { ids: provider.models, infoRules: new Map() };
		}

		const cacheKey = `${provider.id}|${provider.baseUrl}|${readInfo}`;
		const cached = this.cache.get(cacheKey);
		if (cached && cached.expires > Date.now()) {
			return cached.models;
		}

		const ids = await this.fetchModels(provider, apiKey, token);
		const infoRules =
			readInfo && ids.length > 0 ? await this.fetchModelInfo(provider, apiKey, ids, token) : new Map<string, ModelRule>();
		const models = { ids, infoRules };
		this.cache.set(cacheKey, { models, expires: Date.now() + CACHE_TTL_MS });
		return models;
	}

	private async fetchModelInfo(
		provider: ProviderConfig,
		apiKey: string,
		ids: string[],
		token: vscode.CancellationToken,
	): Promise<Map<string, ModelRule>> {
		const url = endpoint(provider, 'model/info');
		const { signal, dispose } = abortOn(token);
		try {
			const response = await fetch(url, { headers: buildHeaders(provider, apiKey, { Accept: 'application/json' }), signal });
			if (!response.ok) {
				if (response.status !== 403 && response.status !== 404) {
					log().warn(`Model metadata for "${provider.id}" unavailable: ${await toHttpError(response, apiKey)}`);
				}
				return new Map();
			}
			return modelInfoRules(await response.json(), ids);
		} catch (error) {
			if (!signal.aborted) {
				log().warn(`Model metadata for "${provider.id}" unavailable: ${scrubSecret(String(error), apiKey)}`);
			}
			return new Map();
		} finally {
			dispose();
		}
	}

	private async fetchModels(provider: ProviderConfig, apiKey: string, token: vscode.CancellationToken): Promise<string[]> {
		const url = endpoint(provider, 'models');
		log().info(`Discovering models for "${provider.id}" via GET ${url}`);
		const { signal, dispose } = abortOn(token);
		try {
			return await withRetry(
				async () => {
					const response = await fetch(url, {
						method: 'GET',
						headers: buildHeaders(provider, apiKey, { Accept: 'application/json' }),
						signal,
					});
					if (!response.ok) {
						throw await toHttpError(response, apiKey);
					}
					const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
					const ids = (body?.data ?? [])
						.map((entry) => entry?.id)
						.filter((id): id is string => typeof id === 'string' && id.length > 0);
					if (ids.length === 0) {
						log().warn(`GET ${url} returned no model ids. Is this an OpenAI-compatible /models endpoint?`);
					}
					return ids;
				},
				{
					token,
					onRetry: (attempt, delay, reason) =>
						log().warn(`Model discovery for "${provider.id}" failed (attempt ${attempt}), retrying in ${delay} ms: ${reason}`),
				},
			);
		} finally {
			dispose();
		}
	}
}
