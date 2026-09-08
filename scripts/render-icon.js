#!/usr/bin/env node
/**
 * Rasterises media/icon.svg to the PNG the Marketplace requires.
 *
 * vsce rejects SVG in `manifest.icon` outright, so the PNG is a build artifact
 * rather than the source of truth — edit the SVG and re-run `npm run icon`.
 */
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { Resvg } = require('@resvg/resvg-js');

const media = join(__dirname, '..', 'media');
const source = join(media, 'icon.svg');
const target = join(media, 'icon.png');
const SIZE = 128;

const resvg = new Resvg(readFileSync(source, 'utf8'), {
	fitTo: { mode: 'width', value: SIZE },
	background: 'rgba(0,0,0,0)',
});

const png = resvg.render().asPng();
writeFileSync(target, png);

console.log(`Rendered ${source} -> ${target} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);
