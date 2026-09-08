import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { estimateImageTokens, estimateTokens } from '../provider/tokenEstimate';

describe('estimateTokens', () => {
	test('charges ASCII at three characters per token', () => {
		assert.equal(estimateTokens('abcdef'), 2);
		assert.equal(estimateTokens('abcdefg'), 3);
	});

	test('charges non-ASCII at one character per token', () => {
		assert.equal(estimateTokens('日本語のテキスト'), 8);
	});

	test('splits mixed text by character class', () => {
		// 6 ASCII → 2 tokens, 3 CJK → 3 tokens.
		assert.equal(estimateTokens('abcdef日本語'), 5);
	});

	test('is zero only for the empty string', () => {
		assert.equal(estimateTokens(''), 0);
		assert.equal(estimateTokens('x'), 1);
	});

	// The property the estimate exists for: never fewer tokens than a real
	// tokenizer would count, or VS Code overfills the prompt and the server
	// answers 400. GPT-style BPE counts this snippet at ~50 tokens (~3.4
	// chars/token for code); the estimate must land above that.
	test('stays above a realistic tokenizer count for source code', () => {
		const snippet =
			'export function estimateTokens(text: string): number {\n\tlet ascii = 0;\n\tlet wide = 0;\n\treturn ascii + wide;\n}\n';
		const realisticTokens = Math.round(snippet.length / 3.4);
		assert.ok(estimateTokens(snippet) >= realisticTokens, `${estimateTokens(snippet)} < ${realisticTokens}`);
	});

	test('stays above a realistic tokenizer count for CJK prose', () => {
		const prose = '私はガラスを食べられます。それは私を傷つけません。';
		// CJK runs ~1–1.5 characters per token on GPT-style tokenizers.
		assert.ok(estimateTokens(prose) >= prose.length / 1.5);
	});
});

describe('estimateImageTokens', () => {
	test('charges a flat, high per-image rate', () => {
		assert.ok(estimateImageTokens() >= 1000);
	});
});
