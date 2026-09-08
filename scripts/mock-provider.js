#!/usr/bin/env node
/**
 * Standalone mock provider for the manual two-window test.
 *
 *   npm run compile
 *   node scripts/mock-provider.js 8787 gpt-4o-mini
 *   node scripts/mock-provider.js 8788 claude-sonnet-4
 *
 * Then open two scratch folders in Extension Development Host windows; each must
 * only offer its own models. Point a folder at a mock from its
 * `.vscode/settings.json`, and enable the cleartext-loopback development
 * setting in your user settings first — `http://` is rejected without it:
 *
 *   {
 *     "workspaceKeys.providers": [
 *       { "id": "mock-a", "label": "Mock A", "baseUrl": "http://127.0.0.1:8787/v1" }
 *     ]
 *   }
 *
 *   // user settings
 *   { "workspaceKeys.allowInsecureLoopback": true }
 *
 * For the second window, use port 8788 and `"apiKey": "${env:MOCK_B_KEY}"` to
 * exercise tier 2 of the key resolution instead of SecretStorage.
 */
const { startMockProvider } = require('../out/test/mockProvider');

const port = Number(process.argv[2] ?? 8787);
const models = process.argv.slice(3);

startMockProvider({ port, ...(models.length > 0 ? { models } : {}) })
	.then((mock) => {
		console.log(`Mock provider listening on ${mock.baseUrl}`);
		console.log(`Models: ${(models.length > 0 ? models : ['<defaults>']).join(', ')}`);
		console.log('Any bearer token is accepted. Press Ctrl+C to stop.');
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
