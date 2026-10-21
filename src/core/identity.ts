/**
 * The token every request carries so the Evaluation API can count SDK usage by
 * name and version (#4144, contract in #4138). The version is inlined from
 * package.json at build time (see globals.d.ts), never written here (#2141).
 */
export const SDK_TOKEN = `featureflip-js/${__SDK_VERSION__}`;

// RFC 9110 `product = token [ "/" product-version ]`, where both halves are tchars.
const PRODUCT = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+(\/[!#$%&'*+.^_`|~0-9A-Za-z-]+)?$/;

/**
 * The SDK token followed by each wrapper token, in order. A wrapper that is not a
 * valid product token is dropped with a warning: identity metadata must never stop
 * the client starting. Filtered defensively because JS callers bypass the types.
 */
export function buildIdentity(wrappers: readonly unknown[] | undefined): string {
  const tokens = [SDK_TOKEN];
  for (const wrapper of wrappers ?? []) {
    if (typeof wrapper === 'string' && PRODUCT.test(wrapper)) {
      tokens.push(wrapper);
    } else {
      console.warn(
        `[featureflip] ignoring wrapper ${JSON.stringify(wrapper)}: not a valid "name/version" product token`,
      );
    }
  }
  return tokens.join(' ');
}
