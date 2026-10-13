/**
 * Renderer/Effects/Shaders/LutData.js
 * Pure helpers of the colour-grading (LUT) pass: the server's catalog, which look a player's choice
 * means, and how a strip image becomes a 3D cube. No WebGL here, so it is unit-tested.
 *
 * A look is a PNG strip of N slices side by side, each N x N: N*N pixels wide and N tall, with the
 * slice index = blue, the column inside a slice = red and the row = green (the usual Unreal/Unity layout).
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

export const LUT_SIZES = [16, 32, 64];

const EMPTY = Object.freeze({ default: null, luts: [] });

/**
 * Validate the catalog published by the server (`luts.json`). Anything unexpected is dropped, never thrown.
 *
 * @param {*} json
 * @returns {{default: ?string, luts: Array<{name: string, title: string, size: number, url: string, sha256: string}>}}
 */
export function parseCatalog(json) {
	if (!json || json.format !== 1 || !Array.isArray(json.luts)) {
		return EMPTY;
	}

	const luts = json.luts.filter(
		l =>
			l &&
			typeof l.name === 'string' &&
			typeof l.title === 'string' &&
			typeof l.url === 'string' &&
			typeof l.sha256 === 'string' &&
			LUT_SIZES.includes(l.size)
	);
	const chosen = typeof json.default === 'string' ? json.default : null;

	return { default: luts.some(l => l.name === chosen) ? chosen : null, luts };
}

/**
 * Which look a player's saved choice means right now.
 *  - 'default': whatever the owner set as the default (nothing if none)
 *  - 'none':    no colour grade
 *  - a name:    that look; if the owner has since removed it, no colour grade
 *
 * @param {string} choice
 * @param {{default: ?string, luts: Array}} catalog
 * @returns {?Object} the catalog entry, or null for no colour grade
 */
export function resolveLut(choice, catalog) {
	const name = choice === 'default' ? catalog.default : choice;
	if (!name || name === 'none') {
		return null;
	}
	return catalog.luts.find(l => l.name === name) || null;
}

/**
 * Repack a decoded strip (RGBA bytes, top row first) into a cube for texImage3D: texel (x, y, z) at
 * ((z * n + y) * n + x) * 4, so x = red, y = green and z = blue. Colours are copied untouched (magenta is
 * a real colour here), and alpha is forced opaque.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {{n: number, data: Uint8Array}}
 */
export function stripToCube(rgba, width, height) {
	const n = height;
	if (!LUT_SIZES.includes(n) || width !== n * n || rgba.length !== width * height * 4) {
		throw new Error(`LUT strip must be N*N by N with N in ${LUT_SIZES.join(', ')} (got ${width}x${height})`);
	}

	const data = new Uint8Array(n * n * n * 4);
	for (let z = 0; z < n; z++) {
		for (let y = 0; y < n; y++) {
			for (let x = 0; x < n; x++) {
				const from = (y * width + z * n + x) * 4;
				const to = ((z * n + y) * n + x) * 4;
				data[to] = rgba[from];
				data[to + 1] = rgba[from + 1];
				data[to + 2] = rgba[from + 2];
				data[to + 3] = 255;
			}
		}
	}
	return { n, data };
}
