import { describe, expect, it } from 'vitest';
import { parseCatalog, resolveLut, stripToCube } from 'Renderer/Effects/Shaders/LutData.js';

const look = (name, size = 16) => ({ name, title: name.toUpperCase(), size, url: `/content/luts/${name}.png`, sha256: `sha-${name}` });

describe('parseCatalog', () => {
	it('keeps valid looks and a default that exists', () => {
		const catalog = parseCatalog({ format: 1, default: 'warm', luts: [look('warm'), look('cold', 32)] });
		expect(catalog.default).toBe('warm');
		expect(catalog.luts.map(l => l.name)).toEqual(['warm', 'cold']);
	});

	it('ignores a default that is not in the list, and non-string defaults', () => {
		expect(parseCatalog({ format: 1, default: 'gone', luts: [look('warm')] }).default).toBeNull();
		expect(parseCatalog({ format: 1, default: 3, luts: [look('warm')] }).default).toBeNull();
		expect(parseCatalog({ format: 1, default: null, luts: [look('warm')] }).default).toBeNull();
	});

	it('drops malformed entries instead of failing', () => {
		const catalog = parseCatalog({
			format: 1,
			luts: [look('ok'), { ...look('big'), size: 128 }, { name: 'x' }, null, { ...look('nourl'), url: 5 }]
		});
		expect(catalog.luts.map(l => l.name)).toEqual(['ok']);
	});

	it('is empty for anything that is not format 1', () => {
		for (const bad of [null, undefined, {}, { format: 2, luts: [look('a')] }, { format: 1, luts: 'x' }, 'text']) {
			expect(parseCatalog(bad)).toEqual({ default: null, luts: [] });
		}
	});
});

describe('resolveLut', () => {
	const catalog = parseCatalog({ format: 1, default: 'warm', luts: [look('warm'), look('cold')] });

	it("'default' is the server's default look", () => {
		expect(resolveLut('default', catalog).name).toBe('warm');
	});

	it("'default' is no grade when the server set none", () => {
		expect(resolveLut('default', parseCatalog({ format: 1, luts: [look('warm')] }))).toBeNull();
	});

	it("'none' is no grade even when the server has a default", () => {
		expect(resolveLut('none', catalog)).toBeNull();
	});

	it('a name picks that look; a removed look means no grade', () => {
		expect(resolveLut('cold', catalog).name).toBe('cold');
		expect(resolveLut('deleted', catalog)).toBeNull();
	});
});

describe('stripToCube', () => {
	/** An N-slice strip as RGBA, every pixel from f(x, y, z). */
	function strip(n, f) {
		const width = n * n;
		const rgba = new Uint8Array(width * n * 4);
		for (let z = 0; z < n; z++) {
			for (let y = 0; y < n; y++) {
				for (let x = 0; x < n; x++) {
					rgba.set([...f(x, y, z), 7], (y * width + z * n + x) * 4);
				}
			}
		}
		return { rgba, width, height: n };
	}
	const at = (n, x, y, z) => ((z * n + y) * n + x) * 4;

	it('puts red across, green down and blue by slice', () => {
		const { rgba, width, height } = strip(16, (x, y, z) => (x === 3 && y === 5 && z === 7 ? [9, 8, 7] : [0, 0, 0]));
		const cube = stripToCube(rgba, width, height);
		expect(cube.n).toBe(16);
		expect([...cube.data.subarray(at(16, 3, 5, 7), at(16, 3, 5, 7) + 3)]).toEqual([9, 8, 7]);
		expect(cube.data.reduce((a, b, i) => a + (i % 4 === 3 ? 0 : b), 0)).toBe(24);
	});

	it('copies magenta and every other colour untouched, and forces alpha opaque', () => {
		const { rgba, width, height } = strip(16, () => [255, 0, 255]);
		const cube = stripToCube(rgba, width, height);
		expect([...cube.data.subarray(0, 4)]).toEqual([255, 0, 255, 255]);
		expect(cube.data.length).toBe(16 * 16 * 16 * 4);
	});

	it('accepts 16, 32 and 64', () => {
		for (const n of [16, 32, 64]) {
			const { rgba, width, height } = strip(n, (x, y, z) => [x, y, z]);
			const cube = stripToCube(rgba, width, height);
			expect(cube.n).toBe(n);
			expect([...cube.data.subarray(at(n, n - 1, 2, 1), at(n, n - 1, 2, 1) + 3)]).toEqual([n - 1, 2, 1]);
		}
	});

	it('refuses other shapes', () => {
		expect(() => stripToCube(new Uint8Array(100 * 16 * 4), 100, 16)).toThrow(/N\*N by N/);
		expect(() => stripToCube(new Uint8Array(400 * 20 * 4), 400, 20)).toThrow();
		expect(() => stripToCube(new Uint8Array(10), 256, 16)).toThrow();
	});
});
