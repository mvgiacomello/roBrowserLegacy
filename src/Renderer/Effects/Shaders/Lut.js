/**
 * Renderer/Effects/Shaders/Lut.js
 * Colour grading with a 3D look-up table (LUT), chosen by the player from the looks the server owner published.
 *
 * The owner's looks come from a catalog (`Configs.lutCatalog`, a JSON file) and each look is a PNG strip, see
 * LutData.js. The strip is fetched once per look, repacked into a cube and kept in memory so a lost WebGL
 * context re-uploads it without another request.
 *
 * Never load a strip through Utils/Texture or WebGL.texture: they turn magenta transparent and resample to a
 * power of two, which corrupts a LUT. It is decoded here with no colour conversion instead.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import Configs from 'Core/Configs.js';
import GraphicsSettings from 'Preferences/Graphics.js';
import WebGL from 'Utils/WebGL.js';
import PostProcess from 'Renderer/Effects/PostProcess.js';
import commonVS from './GLSL/Common.vs?raw';
import lutFS from './GLSL/Lut.fs?raw';
import { parseCatalog, resolveLut, stripToCube } from './LutData.js';

const EMPTY_CATALOG = { default: null, luts: [] };

let _program, _buffer, _gl;
let _texture = null;
/** @type {?{n: number, data: Uint8Array, sha256: string}} The look in memory. */
let _cube = null;
let _catalog = null;
let _catalogPromise = null;
/** sha256 being fetched, and the ones that failed (not retried this session). */
let _loading = null;
const _failed = new Set();

function catalogUrl() {
	const url = Configs.get('lutCatalog', '');
	return url ? new URL(url, window.location.href).href : '';
}

/**
 * Decode a strip's bytes with no colour management or alpha premultiplication, so the pixels the browser
 * hands over are the ones in the file.
 */
async function decodeStrip(blob) {
	const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
	// close() zeroes width and height, so read them first.
	const { width, height } = bitmap;
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
	ctx.drawImage(bitmap, 0, 0);
	if (bitmap.close) {
		bitmap.close();
	}
	return { rgba: ctx.getImageData(0, 0, width, height).data, width, height };
}

function uploadCube(gl, cube) {
	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_3D, texture);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
	gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, cube.n, cube.n, cube.n, 0, gl.RGBA, gl.UNSIGNED_BYTE, cube.data);
	gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
	gl.bindTexture(gl.TEXTURE_3D, null);
	return texture;
}

class Lut {
	/**
	 * The server's looks. Fetched once; `force` fetches again (the Graphics window does, so a look the owner
	 * just added shows up). A missing or broken catalog is an empty one: the feature stays hidden.
	 *
	 * @param {boolean} [force]
	 * @returns {Promise<{default: ?string, luts: Array}>}
	 */
	static loadCatalog(force = false) {
		if (_catalogPromise && !force) {
			return _catalogPromise;
		}

		const url = catalogUrl();
		_catalogPromise = (url ? fetch(url, { credentials: 'omit' }) : Promise.reject(new Error('no catalog configured')))
			.then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
			.then(parseCatalog)
			.catch(() => EMPTY_CATALOG)
			.then(catalog => (_catalog = catalog));
		return _catalogPromise;
	}

	/** The catalog already loaded, or null before the first load finishes. */
	static catalog() {
		return _catalog;
	}

	/** Fetch, decode and keep a look; the pass uses it from the next frame. A failure is remembered. */
	static async load(entry) {
		if (_loading === entry.sha256 || _failed.has(entry.sha256)) {
			return;
		}
		_loading = entry.sha256;
		try {
			const res = await fetch(new URL(entry.url, catalogUrl() || window.location.href).href, { credentials: 'omit' });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const { rgba, width, height } = await decodeStrip(await res.blob());
			const cube = stripToCube(rgba, width, height);
			if (cube.n !== entry.size) {
				throw new Error(`strip is ${cube.n}, catalog says ${entry.size}`);
			}
			_cube = { ...cube, sha256: entry.sha256 };
			if (_gl) {
				if (_texture) {
					_gl.deleteTexture(_texture);
				}
				_texture = uploadCube(_gl, _cube);
			}
		} catch (e) {
			_failed.add(entry.sha256);
			console.warn(`[Lut] Could not load "${entry.name}":`, e.message || e);
		} finally {
			if (_loading === entry.sha256) {
				_loading = null;
			}
		}
	}

	static render(gl, inputTexture, outputFbo) {
		if (!_buffer || !_program || !_texture || !_cube) {
			return;
		}

		PostProcess.beforeRenderPass(gl, outputFbo);
		gl.useProgram(_program);

		gl.uniform1f(_program.uniform.uLutSize, _cube.n);
		gl.uniform1f(_program.uniform.uIntensity, Math.min(1, Math.max(0, GraphicsSettings.lutIntensity)));

		gl.bindBuffer(gl.ARRAY_BUFFER, _buffer);
		const posLoc = _program.attribute.aPosition;
		gl.enableVertexAttribArray(posLoc);
		gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, inputTexture);
		gl.uniform1i(_program.uniform.uTexture, 0);

		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_3D, _texture);
		gl.uniform1i(_program.uniform.uLut, 1);

		gl.drawArrays(gl.TRIANGLES, 0, 6);

		gl.bindTexture(gl.TEXTURE_3D, null);
		gl.activeTexture(gl.TEXTURE0);
		PostProcess.afterRenderPass(gl);
	}

	static init(gl) {
		if (!gl) {
			return;
		}
		_gl = gl;
		try {
			_program = WebGL.createShaderProgram(gl, commonVS, lutFS);
		} catch (e) {
			console.error('Error compiling Lut shader.', e);
			return;
		}
		const quadVertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
		_buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, _buffer);
		gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

		// A new context (map change, context loss): the look in memory goes back to the GPU.
		if (_cube) {
			_texture = uploadCube(gl, _cube);
		}
	}

	/**
	 * Asked once per frame by PostProcess.prepare(): true only while there is a look on the GPU to draw. A pass that
	 * answered true without one would leave the screen empty, so a look still loading keeps the previous one (or none).
	 * This is also where a look the player chose starts loading.
	 */
	static isActive() {
		if (!_catalog) {
			Lut.loadCatalog();
			return false;
		}

		const entry = resolveLut(GraphicsSettings.lutName, _catalog);
		if (!entry || !(GraphicsSettings.lutIntensity > 0)) {
			return false;
		}

		if ((!_cube || _cube.sha256 !== entry.sha256) && !_failed.has(entry.sha256)) {
			Lut.load(entry);
		}
		return !!_texture;
	}

	static program() {
		return _program;
	}

	static clean(gl) {
		if (_buffer) {
			gl.deleteBuffer(_buffer);
		}
		if (_texture) {
			gl.deleteTexture(_texture);
		}
		_program = _buffer = _texture = null;
	}
}
export default Lut;
