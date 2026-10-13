import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = { lutName: 'default', lutIntensity: 1 };
const configs = { lutCatalog: 'http://game.test/content/luts.json' };

vi.mock('Renderer/Effects/Shaders/GLSL/Common.vs?raw', () => ({ default: 'vs' }));
vi.mock('Renderer/Effects/Shaders/GLSL/Lut.fs?raw', () => ({ default: 'fs' }));
vi.mock('Preferences/Graphics.js', () => ({ default: settings }));
vi.mock('Core/Configs.js', () => ({ default: { get: (key, fallback) => (key in configs ? configs[key] : fallback) } }));
vi.mock('Renderer/Effects/PostProcess.js', () => ({ default: { beforeRenderPass: vi.fn(), afterRenderPass: vi.fn() } }));
vi.mock('Utils/WebGL.js', () => ({
	default: {
		createShaderProgram: () => ({
			uniform: { uTexture: 't', uLut: 'l', uLutSize: 's', uIntensity: 'i' },
			attribute: { aPosition: 0 }
		})
	}
}));

const catalogJson = (extra = {}) => ({
	format: 1,
	default: null,
	luts: [
		{ name: 'warm', title: 'Warm', size: 16, url: '/content/luts/warm.png', sha256: 'sha-warm' },
		{ name: 'cold', title: 'Cold', size: 16, url: '/content/luts/cold.png', sha256: 'sha-cold' }
	],
	...extra
});

function makeGl() {
	const target = { texImage3D: vi.fn(), deleteTexture: vi.fn(), drawArrays: vi.fn(), createTexture: vi.fn(() => ({ id: Math.random() })), createBuffer: vi.fn(() => ({})) };
	// Constants (TEXTURE0, LINEAR...) read back as their own names; any other method is one remembered mock.
	return new Proxy(target, {
		get(t, prop) {
			if (!(prop in t)) {
				t[prop] = typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop) ? prop : vi.fn();
			}
			return t[prop];
		}
	});
}

/** A fetch that serves the catalog and the strips, counting each request. */
function stubNetwork({ catalog = catalogJson(), strips = { '/content/luts/warm.png': 'ok', '/content/luts/cold.png': 'ok' } } = {}) {
	const calls = [];
	globalThis.fetch = vi.fn(async url => {
		const path = new URL(url).pathname;
		calls.push(path);
		if (path === '/content/luts.json') {
			return catalog === null ? { ok: false, status: 404 } : { ok: true, json: async () => catalog };
		}
		return strips[path] === 'ok' ? { ok: true, blob: async () => ({ path }) } : { ok: false, status: 404 };
	});
	return calls;
}

/** A decodable 16-slice strip, every pixel the same. */
function stubDecoding(width = 256, height = 16) {
	// Like the real thing, closing a bitmap zeroes its size.
	globalThis.createImageBitmap = vi.fn(async () => {
		const bitmap = { width, height, close: () => ((bitmap.width = 0), (bitmap.height = 0)) };
		return bitmap;
	});
	const real = document.createElement.bind(document);
	vi.spyOn(document, 'createElement').mockImplementation(tag =>
		tag === 'canvas'
			? {
					getContext: () => ({
						drawImage: vi.fn(),
						getImageData: (_x, _y, w, h) => {
							if (!w || !h) {
								throw new Error('The source width is 0.');
							}
							return { data: new Uint8ClampedArray(w * h * 4).fill(128) };
						}
					})
				}
			: real(tag)
	);
}

const settle = async () => {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
	await new Promise(resolve => setTimeout(resolve, 0));
};

let Lut;
beforeEach(async () => {
	vi.restoreAllMocks();
	vi.resetModules();
	settings.lutName = 'default';
	settings.lutIntensity = 1;
	configs.lutCatalog = 'http://game.test/content/luts.json';
	({ default: Lut } = await import('Renderer/Effects/Shaders/Lut.js'));
});

describe('the catalog', () => {
	it('is fetched on the first frame and the pass stays off until it is there', async () => {
		const calls = stubNetwork();
		expect(Lut.isActive()).toBe(false);
		expect(Lut.isActive()).toBe(false);
		await settle();
		expect(calls.filter(p => p === '/content/luts.json')).toHaveLength(1);
		expect(Lut.catalog().luts).toHaveLength(2);
	});

	it('is empty (feature hidden, no error) when it is missing, broken or not configured', async () => {
		stubNetwork({ catalog: null });
		expect((await Lut.loadCatalog()).luts).toEqual([]);

		vi.resetModules();
		({ default: Lut } = await import('Renderer/Effects/Shaders/Lut.js'));
		globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ nonsense: true }) }));
		expect((await Lut.loadCatalog()).luts).toEqual([]);

		vi.resetModules();
		configs.lutCatalog = '';
		({ default: Lut } = await import('Renderer/Effects/Shaders/Lut.js'));
		globalThis.fetch = vi.fn();
		expect((await Lut.loadCatalog()).luts).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('is fetched again on request, so a look added meanwhile shows up', async () => {
		const calls = stubNetwork();
		await Lut.loadCatalog();
		await Lut.loadCatalog(true);
		expect(calls.filter(p => p === '/content/luts.json')).toHaveLength(2);
	});
});

describe('choosing what to draw', () => {
	it("'default' with no server default, and 'none', never fetch a strip", async () => {
		const calls = stubNetwork();
		await Lut.loadCatalog();
		for (const choice of ['default', 'none', 'deleted-look']) {
			settings.lutName = choice;
			expect(Lut.isActive()).toBe(false);
		}
		await settle();
		expect(calls.filter(p => p.endsWith('.png'))).toEqual([]);
	});

	it("'default' follows the server's default look", async () => {
		const calls = stubNetwork({ catalog: catalogJson({ default: 'cold' }) });
		stubDecoding();
		await Lut.loadCatalog();
		Lut.init(makeGl());
		Lut.isActive();
		await settle();
		expect(calls).toContain('/content/luts/cold.png');
		expect(Lut.isActive()).toBe(true);
	});

	it('a look is fetched once however many frames ask, and the pass turns on only when it is on the GPU', async () => {
		const calls = stubNetwork();
		stubDecoding();
		const gl = makeGl();
		await Lut.loadCatalog();
		Lut.init(gl);
		settings.lutName = 'warm';
		expect(Lut.isActive()).toBe(false);
		expect(Lut.isActive()).toBe(false);
		await settle();
		expect(calls.filter(p => p === '/content/luts/warm.png')).toHaveLength(1);
		expect(Lut.isActive()).toBe(true);
		expect(gl.texImage3D).toHaveBeenCalledTimes(1);
		const args = gl.texImage3D.mock.calls[0];
		expect(args.slice(3, 6)).toEqual([16, 16, 16]);
		expect(args[9]).toHaveLength(16 * 16 * 16 * 4);
	});

	it('intensity 0 turns the pass off without fetching', async () => {
		const calls = stubNetwork();
		await Lut.loadCatalog();
		settings.lutName = 'warm';
		settings.lutIntensity = 0;
		expect(Lut.isActive()).toBe(false);
		await settle();
		expect(calls.filter(p => p.endsWith('.png'))).toEqual([]);
	});

	it('the strip is decoded with no colour conversion or premultiplication', async () => {
		stubNetwork();
		stubDecoding();
		await Lut.loadCatalog();
		Lut.init(makeGl());
		settings.lutName = 'warm';
		Lut.isActive();
		await settle();
		expect(globalThis.createImageBitmap.mock.calls[0][1]).toEqual({ colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
	});
});

describe('failures and switching', () => {
	it('a strip that cannot be loaded is not retried, never throws, and leaves the pass off', async () => {
		const calls = stubNetwork({ strips: {} });
		await Lut.loadCatalog();
		Lut.init(makeGl());
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		settings.lutName = 'warm';
		Lut.isActive();
		await settle();
		for (let i = 0; i < 5; i++) {
			expect(Lut.isActive()).toBe(false);
		}
		await settle();
		expect(calls.filter(p => p.endsWith('warm.png'))).toHaveLength(1);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('a strip of the wrong size for the catalog is refused', async () => {
		stubNetwork();
		stubDecoding(400, 20);
		await Lut.loadCatalog();
		Lut.init(makeGl());
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		settings.lutName = 'warm';
		Lut.isActive();
		await settle();
		expect(Lut.isActive()).toBe(false);
	});

	it('switching looks keeps drawing the old one until the new one is ready, and "None" turns it off at once', async () => {
		stubNetwork();
		stubDecoding();
		const gl = makeGl();
		await Lut.loadCatalog();
		Lut.init(gl);
		settings.lutName = 'warm';
		Lut.isActive();
		await settle();
		expect(Lut.isActive()).toBe(true);

		settings.lutName = 'cold';
		expect(Lut.isActive()).toBe(true); // still the warm texture while cold loads
		await settle();
		expect(gl.texImage3D).toHaveBeenCalledTimes(2);
		expect(gl.deleteTexture).toHaveBeenCalledTimes(1);

		settings.lutName = 'none';
		expect(Lut.isActive()).toBe(false);
	});

	it('a new WebGL context gets the look back without another request', async () => {
		const calls = stubNetwork();
		stubDecoding();
		await Lut.loadCatalog();
		Lut.init(makeGl());
		settings.lutName = 'warm';
		Lut.isActive();
		await settle();

		const first = makeGl();
		Lut.clean(first);
		expect(Lut.isActive()).toBe(false); // nothing on the GPU: do not draw
		const second = makeGl();
		Lut.init(second);
		expect(Lut.isActive()).toBe(true);
		expect(second.texImage3D).toHaveBeenCalledTimes(1);
		expect(calls.filter(p => p.endsWith('warm.png'))).toHaveLength(1);
	});
});

describe('drawing', () => {
	it('binds the scene on unit 0 and the cube on unit 1, then restores unit 0', async () => {
		stubNetwork();
		stubDecoding();
		const gl = makeGl();
		await Lut.loadCatalog();
		Lut.init(gl);
		settings.lutName = 'warm';
		settings.lutIntensity = 0.5;
		Lut.isActive();
		await settle();

		Lut.render(gl, 'scene', null);
		expect(gl.uniform1f).toHaveBeenCalledWith('s', 16);
		expect(gl.uniform1f).toHaveBeenCalledWith('i', 0.5);
		expect(gl.uniform1i).toHaveBeenCalledWith('t', 0);
		expect(gl.uniform1i).toHaveBeenCalledWith('l', 1);
		expect(gl.drawArrays).toHaveBeenCalledTimes(1);
		const units = gl.activeTexture.mock.calls.map(c => c[0]);
		expect(units).toEqual(['TEXTURE0', 'TEXTURE1', 'TEXTURE0']);
	});

	it('draws nothing without a look on the GPU', () => {
		const gl = makeGl();
		Lut.init(gl);
		Lut.render(gl, 'scene', null);
		expect(gl.drawArrays).not.toHaveBeenCalled();
	});
});
