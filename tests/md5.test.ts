import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { md5Bytes } from '../src/platform/browser.js';

function nodeMd5(input: string): Uint8Array {
  return createHash('md5').update(input, 'utf8').digest();
}

describe('browser MD5 vs Node crypto MD5', () => {
  const testCases = [
    '',
    'hello',
    'test-salt:user-42',
    'a',
    'The quick brown fox jumps over the lazy dog',
    'salt:',
    ':value',
    'some-flag-salt:user-id-12345',
    // Longer string to test multi-block processing
    'a'.repeat(100),
    // Exactly 55 bytes (edge case for padding)
    'a'.repeat(55),
    // Exactly 56 bytes (another padding edge case)
    'a'.repeat(56),
    // Exactly 64 bytes (one full block)
    'a'.repeat(64),
  ];

  for (const input of testCases) {
    it(`matches for input: "${input.length > 30 ? input.slice(0, 30) + '...' : input}"`, () => {
      const browserResult = md5Bytes(input);
      const nodeResult = nodeMd5(input);
      expect(Array.from(browserResult)).toEqual(Array.from(nodeResult));
    });
  }

  it('produces correct bucket values for rollout compatibility', () => {
    // Test that bucketing with browser MD5 matches Node MD5
    const inputs = [
      { salt: 'flag-salt', value: 'user-1' },
      { salt: 'flag-salt', value: 'user-2' },
      { salt: 'another-salt', value: 'user-123' },
    ];

    for (const { salt, value } of inputs) {
      const input = `${salt}:${value}`;
      const browserHash = md5Bytes(input);
      const nodeHash = nodeMd5(input);

      // Read first 4 bytes as little-endian uint32
      const browserBucket =
        ((browserHash[0]!) |
          (browserHash[1]! << 8) |
          (browserHash[2]! << 16) |
          ((browserHash[3]! << 24) >>> 0)) >>> 0;
      const nodeBucket =
        ((nodeHash[0]!) |
          (nodeHash[1]! << 8) |
          (nodeHash[2]! << 16) |
          ((nodeHash[3]! << 24) >>> 0)) >>> 0;

      expect(browserBucket % 100).toBe(nodeBucket % 100);
    }
  });
});
