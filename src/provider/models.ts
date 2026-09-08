import * as vscode from 'vscode';
import type { ProviderConfig } from '../types';
import { abortOn, buildHeaders, endpoint, toHttpError } from './http';
import { withRetry } from '../util/backoff';
import { log } from '../util/log';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
	models: string[];
	expires: number;
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

	async list(provider: ProviderConfig, apiKey: string, token: vscode.CancellationToken): Promise<string[]> {
		if (provider.models && provider.models.length > 0) {
			return provider.models;
		}

		const cacheKey = `${provider.id}|${provider.baseUrl}`;
		const cached = this.cache.get(cacheKey);
		if (cached && cached.expires > Date.now()) {
			return cached.models;
		}

		const models = await this.fetchModels(provider, apiKey, token);
		this.cache.set(cacheKey, { models, expires: Date.now() + CACHE_TTL_MS });
		return models;
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
