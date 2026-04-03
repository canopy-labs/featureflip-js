import { t as e } from "./client-ChXPtrh5.js";
//#region src/platform/browser.ts
function t() {
	return {
		md5(e) {
			return i(e);
		},
		createEventSource(e, t) {
			let n = new EventSource(e);
			return {
				addEventListener: (e, t) => {
					n.addEventListener(e, (e) => t(e));
				},
				close: () => n.close(),
				get readyState() {
					return n.readyState;
				}
			};
		},
		async fetch(e, t) {
			return globalThis.fetch(e, t);
		}
	};
}
var n = [
	7,
	12,
	17,
	22,
	7,
	12,
	17,
	22,
	7,
	12,
	17,
	22,
	7,
	12,
	17,
	22,
	5,
	9,
	14,
	20,
	5,
	9,
	14,
	20,
	5,
	9,
	14,
	20,
	5,
	9,
	14,
	20,
	4,
	11,
	16,
	23,
	4,
	11,
	16,
	23,
	4,
	11,
	16,
	23,
	4,
	11,
	16,
	23,
	6,
	10,
	15,
	21,
	6,
	10,
	15,
	21,
	6,
	10,
	15,
	21,
	6,
	10,
	15,
	21
], r = new Uint32Array(64);
for (let e = 0; e < 64; e++) r[e] = Math.floor(2 ** 32 * Math.abs(Math.sin(e + 1))) >>> 0;
function i(e) {
	let t = new TextEncoder().encode(e), i = t.length * 8, a = (56 - (t.length + 1) % 64 + 64) % 64, o = new Uint8Array(t.length + 1 + a + 8);
	o.set(t), o[t.length] = 128;
	let s = new DataView(o.buffer);
	s.setUint32(o.length - 8, i >>> 0, !0), s.setUint32(o.length - 4, 0, !0);
	let c = 1732584193, l = 4023233417, u = 2562383102, d = 271733878;
	for (let e = 0; e < o.length; e += 64) {
		let t = new Uint32Array(16);
		for (let n = 0; n < 16; n++) t[n] = s.getUint32(e + n * 4, !0);
		let i = c, a = l, o = u, f = d;
		for (let e = 0; e < 64; e++) {
			let s, c;
			e < 16 ? (s = a & o | ~a & f, c = e) : e < 32 ? (s = f & a | ~f & o, c = (5 * e + 1) % 16) : e < 48 ? (s = a ^ o ^ f, c = (3 * e + 5) % 16) : (s = o ^ (a | ~f), c = 7 * e % 16), s = s + i + r[e] + t[c] >>> 0, i = f, f = o, o = a, a = a + (s << n[e] | s >>> 32 - n[e]) >>> 0;
		}
		c = c + i >>> 0, l = l + a >>> 0, u = u + o >>> 0, d = d + f >>> 0;
	}
	let f = new Uint8Array(16), p = new DataView(f.buffer);
	return p.setUint32(0, c, !0), p.setUint32(4, l, !0), p.setUint32(8, u, !0), p.setUint32(12, d, !0), f;
}
//#endregion
export { e as FeatureflipClient, t as createBrowserPlatform };
