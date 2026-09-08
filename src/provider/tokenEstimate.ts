/**
 * Character-class token estimate rather than a real tokenizer: the vendor
 * serves arbitrary models, so no single tokenizer is correct. This module is
 * the one place to swap in `gpt-tokenizer` if the estimate proves too coarse.
 *
 * The ratios deliberately overestimate. VS Code budgets the prompt from this
 * number: an overestimate costs some usable context, an underestimate overfills
 * the prompt and the server answers 400. ASCII prose runs ~4 chars/token and
 * code ~3, so 3 is the safe side of both; non-ASCII text (CJK above all) can
 * reach 1 char/token, so it is charged at exactly that.
 */

const ASCII_CHARS_PER_TOKEN = 3;
const IMAGE_TOKENS = 1500;

export function estimateTokens(text: string): number {
	let ascii = 0;
	let wide = 0;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) < 128) {
			ascii++;
		} else {
			wide++;
		}
	}
	return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) + wide;
}

/** Flat, deliberately high charge per image — dimensions are not known here. */
export function estimateImageTokens(): number {
	return IMAGE_TOKENS;
}
