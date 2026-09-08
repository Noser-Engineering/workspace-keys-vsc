#!/usr/bin/env node
/**
 * Release hygiene gate for the published artifact.
 *
 * Checks positive invariants rather than a denylist of old names, so the check
 * itself carries nothing that should not be public:
 *
 * 1. every contributed setting and command uses the one configuration prefix,
 * 2. the language-model vendor matches the extension name, because both end up
 *    in ids that cannot be changed after the first release,
 * 3. an SPDX license is declared and the license file exists,
 * 4. no endpoint ships as a default — the provider list starts empty,
 * 5. no absolute URL in the shipped or repository files points at a host that is
 *    not documentation, an example host or loopback.
 *
 *   node scripts/check-hygiene.js
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const problems = [];

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const PREFIX = 'workspaceKeys';

// 1. Settings and commands share one prefix.
for (const key of Object.keys(manifest.contributes?.configuration?.properties ?? {})) {
	if (!key.startsWith(`${PREFIX}.`)) {
		problems.push(`setting "${key}" does not use the "${PREFIX}." prefix`);
	}
}
for (const command of manifest.contributes?.commands ?? []) {
	if (!command.command?.startsWith(`${PREFIX}.`)) {
		problems.push(`command "${command.command}" does not use the "${PREFIX}." prefix`);
	}
}
for (const configuration of manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? []) {
	if (!configuration.startsWith(`${PREFIX}.`)) {
		problems.push(`restricted configuration "${configuration}" does not use the "${PREFIX}." prefix`);
	}
}

// 2. Vendor and extension name are both permanent ids; keep them in step.
for (const contributed of manifest.contributes?.languageModelChatProviders ?? []) {
	if (contributed.vendor !== manifest.name) {
		problems.push(`vendor "${contributed.vendor}" does not match the extension name "${manifest.name}"`);
	}
	if (!contributed.managementCommand?.startsWith(`${PREFIX}.`)) {
		problems.push(`managementCommand "${contributed.managementCommand}" does not use the "${PREFIX}." prefix`);
	}
}

// 2b. Repository, homepage and bugs must name the same repository, so a rename
// cannot leave a stale link on the Marketplace page.
const slugs = [
	['repository', slugOf(manifest.repository?.url)],
	['homepage', slugOf(manifest.homepage)],
	['bugs', slugOf(manifest.bugs?.url)],
];
const named = slugs.filter(([, slug]) => slug !== undefined);
if (named.length !== slugs.length) {
	problems.push(`repository, homepage and bugs must all be set: missing ${slugs.filter(([, s]) => !s).map(([f]) => f).join(', ')}`);
} else if (new Set(named.map(([, slug]) => slug)).size !== 1) {
	problems.push(`repository, homepage and bugs point at different repositories: ${named.map(([f, s]) => `${f}=${s}`).join(', ')}`);
}

// 3. A public release needs a real license, declared as an SPDX id so the
// Marketplace can show it, and the file it refers to.
if (typeof manifest.license !== 'string' || /^see license/i.test(manifest.license)) {
	problems.push(`license must be an SPDX identifier, not "${manifest.license}"`);
}
if (!fs.existsSync(path.join(root, 'LICENSE')) && !fs.existsSync(path.join(root, 'LICENSE.md'))) {
	problems.push('no LICENSE file');
}

// 4. No endpoint ships with the extension.
const providersDefault = manifest.contributes?.configuration?.properties?.[`${PREFIX}.providers`]?.default;
if (!Array.isArray(providersDefault) || providersDefault.length > 0) {
	problems.push(`${PREFIX}.providers must default to an empty list; an endpoint must not ship with the extension`);
}

// 5. Only documentation, example and loopback hosts may appear in shipped files.
const ALLOWED_HOSTS = new Set([
	'localhost',
	'code.visualstudio.com',
	'marketplace.visualstudio.com',
	'github.com',
	'docs.github.com',
	'www.w3.org',
	'spdx.org',
	'keepachangelog.com',
]);

/** Reserved documentation domains, plus loopback literals and placeholders. */
function isAllowedHost(host) {
	if (host.length === 0 || host.includes('${') || host.includes('<')) {
		return true;
	}
	if (ALLOWED_HOSTS.has(host)) {
		return true;
	}
	if (/(^|\.)example\.(com|org|net)$/.test(host) || /(^|\.)example\.(co\.uk|com\.au)$/.test(host)) {
		return true;
	}
	return host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

const urlPattern = /https?:\/\/([^\s"'`)/\\<>,;]+)/g;

for (const file of shippedFiles()) {
	const text = fs.readFileSync(file, 'utf8');
	for (const match of text.matchAll(urlPattern)) {
		const host = hostOf(match[1]);
		if (!isAllowedHost(host)) {
			problems.push(`${path.relative(root, file)}: unexpected host "${host}"`);
		}
	}
}

/** `owner/repo` of a GitHub URL, or undefined when there is none to read. */
function slugOf(url) {
	if (typeof url !== 'string') {
		return undefined;
	}
	const match = url.match(/github\.com\/([^/#?]+)\/([^/#?.]+)/i);
	return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}

/** Reduces an authority to its host: no userinfo, no port, lower case. */
function hostOf(authority) {
	const withoutUserInfo = authority.slice(authority.lastIndexOf('@') + 1);
	const bracketed = withoutUserInfo.match(/^\[[^\]]*\]/);
	const host = bracketed ? bracketed[0] : withoutUserInfo.split(':')[0];
	return host.replace(/[.,]$/, '').toLowerCase();
}

function shippedFiles() {
	const files = [
		path.join(root, 'package.json'),
		path.join(root, 'README.md'),
		path.join(root, 'CHANGELOG.md'),
		path.join(root, 'AGENTS.md'),
	].filter((file) => fs.existsSync(file));

	const walk = (directory, extensions) => {
		if (!fs.existsSync(directory)) {
			return;
		}
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(full, extensions);
			} else if (extensions.some((extension) => entry.name.endsWith(extension))) {
				files.push(full);
			}
		}
	};
	walk(path.join(root, 'src'), ['.ts']);
	walk(path.join(root, 'scripts'), ['.js']);
	// Not shipped, but part of the public repository.
	walk(path.join(root, 'docs'), ['.md']);
	walk(path.join(root, '.github'), ['.yml', '.md']);
	return files;
}

if (problems.length > 0) {
	console.error('Release hygiene check failed:');
	for (const problem of problems) {
		console.error(`  - ${problem}`);
	}
	process.exit(1);
}
console.log('Release hygiene check passed.');
