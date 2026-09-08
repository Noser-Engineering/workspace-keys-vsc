// @ts-check
const tseslint = require('typescript-eslint');

/**
 * Type-aware linting, because the rules worth having here need types.
 *
 * `no-floating-promises` is the reason this config exists: the codebase
 * deliberately fires notifications without awaiting them, and marks every such
 * call with `void`. A dropped `void` is otherwise invisible — and in the
 * discovery path it would swallow a rejection.
 *
 * Formatting is Prettier's job; nothing here overlaps with it.
 */
module.exports = tseslint.config(
	{
		ignores: ['out/**', 'node_modules/**', 'scripts/**', 'media/**', 'eslint.config.js'],
	},
	...tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: __dirname,
			},
		},
		rules: {
			// TypeScript already reports these via noUnusedLocals/noUnusedParameters,
			// with the same underscore convention.
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			// `describe`/`test` from node:test return promises that the runner owns.
			// Awaiting them is wrong, so they are declared safe rather than the rule
			// being switched off for test files — where a genuinely dropped promise
			// would hide a failing assertion.
			'@typescript-eslint/no-floating-promises': [
				'error',
				{
					allowForKnownSafeCalls: [
						{
							from: 'package',
							package: 'node:test',
							name: ['describe', 'it', 'test', 'suite', 'before', 'after', 'beforeEach', 'afterEach'],
						},
					],
				},
			],
			// An `async` method with no `await` is normal here: it satisfies a
			// promise-returning VS Code interface, or stands in for one in a fake.
			'@typescript-eslint/require-await': 'off',
			// The VS Code API hands out `any` in several places (modelOptions, tool
			// results); those sites are narrowed by hand and documented.
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			// Template literals carrying ids, counts and paths are the norm here.
			'@typescript-eslint/restrict-template-expressions': 'off',
		},
	},
);
