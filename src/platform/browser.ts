import type { Platform } from './types.js';

export function createBrowserPlatform(): Platform {
  return {
    md5(input: string): Uint8Array {
      // SubtleCrypto doesn't support MD5 (not in WebCrypto spec).
      // Use a pure-JS MD5 implementation.
      return md5Bytes(input);
    },

    createEventSource(url: string, _headers: Record<string, string>) {
      // Browser EventSource doesn't support custom headers.
      // SDK key must be passed as query param for browser SSE.
      const es = new EventSource(url);
      return {
        addEventListener: (type: string, listener: (event: { data: string }) => void) => {
          es.addEventListener(type, (e) => listener(e as unknown as { data: string }));
        },
        close: () => es.close(),
        get readyState() {
          return es.readyState;
        },
      };
    },

    async fetch(url: string, init?: RequestInit): Promise<Response> {
      return globalThis.fetch(url, init);
    },
  };
}

// Minimal MD5 implementation for browser (no external deps)
// Based on RFC 1321

// Per-round shift amounts (module-level constant)
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

// Pre-computed K table (module-level constant)
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(2 ** 32 * Math.abs(Math.sin(i + 1))) >>> 0;
}

function md5Bytes(input: string): Uint8Array {
  const bytes = new TextEncoder().encode(input);

  // Pre-processing: adding padding bits
  const bitLen = bytes.length * 8;
  const padLen = ((56 - ((bytes.length + 1) % 64)) + 64) % 64;
  const padded = new Uint8Array(bytes.length + 1 + padLen + 8);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  // Append original length in bits as 64-bit little-endian
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, 0, true);

  // Initialize hash values
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  // Process each 512-bit block
  for (let offset = 0; offset < padded.length; offset += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = view.getUint32(offset + j * 4, true);
    }

    let A = a0, B = b0, C = c0, D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]!) | (F >>> (32 - S[i]!)))) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const result = new Uint8Array(16);
  const resultView = new DataView(result.buffer);
  resultView.setUint32(0, a0, true);
  resultView.setUint32(4, b0, true);
  resultView.setUint32(8, c0, true);
  resultView.setUint32(12, d0, true);

  return result;
}

export { md5Bytes };
