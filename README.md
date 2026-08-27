# @featureflip/js

Server-side JavaScript/TypeScript SDK for [Featureflip](https://featureflip.io) - evaluate feature flags locally with near-zero latency.

## Installation

```bash
npm install @featureflip/js
```

## Quick Start

```ts
import { FeatureflipClient, createNodePlatform } from '@featureflip/js';

const client = FeatureflipClient.get(
  { sdkKey: 'your-sdk-key', baseUrl: 'https://eval.featureflip.io' },
  createNodePlatform(),
);

await client.waitForInitialization();

const enabled = client.boolVariation('my-feature', { user_id: '123' }, false);

if (enabled) {
  console.log('Feature is enabled!');
}

await client.close();
```

> **Singleton by construction.** `FeatureflipClient.get()` is the only way to obtain a client. Calling `get()` more than once with the same SDK key returns handles pointing at one shared underlying client — the factory is refcounted, so closing a handle only shuts down the shared core when the last handle is closed. This makes the SDK safe to call from per-request handlers and DI containers without leaking SSE connections.

## Configuration

```ts
const client = FeatureflipClient.get(
  {
    sdkKey: 'your-sdk-key',
    baseUrl: 'https://eval.featureflip.io', // Evaluation API URL
    streaming: true,           // Use SSE for real-time updates (default)
    pollInterval: 30000,       // Polling interval in ms if streaming=false
    flushInterval: 30000,      // Event flush interval in ms
    flushBatchSize: 100,       // Events per batch
    initTimeout: 10000,        // Max ms to wait for initialization
    maxStreamRetries: 5,       // SSE retries before falling back to polling
  },
  createNodePlatform(),
);
```

## Evaluation

```ts
const context = { user_id: '123', email: 'user@example.com' };

// Boolean flag
const enabled = client.boolVariation('feature-key', context, false);

// String flag
const tier = client.stringVariation('pricing-tier', context, 'free');

// Number flag
const limit = client.numberVariation('rate-limit', context, 100);

// JSON flag
const config = client.jsonVariation('ui-config', context, { theme: 'light' });
```

### Detailed Evaluation

```ts
const detail = client.variationDetail('feature-key', { user_id: '123' }, false);

console.log(detail.value);   // The evaluated value
console.log(detail.reason);  // "RuleMatch", "Fallthrough", "FlagDisabled", etc.
console.log(detail.ruleId);  // Rule ID if reason is "RuleMatch"
```

## Event Tracking

```ts
// Track custom events
client.track('checkout-completed', { user_id: '123' }, { total: 99.99 });

// Record an identify event for analytics (does not affect flag evaluation)
client.identify({ user_id: '123', email: 'user@example.com', plan: 'pro' });

// Force flush pending events
await client.flush();
```

## Testing

Use `forTesting()` to create a client with predetermined flag values -- no network calls.

```ts
const client = FeatureflipClient.forTesting({
  'my-feature': true,
  'pricing-tier': 'pro',
});

client.boolVariation('my-feature', {}, false);     // true
client.stringVariation('pricing-tier', {}, 'free'); // 'pro'
client.boolVariation('unknown', {}, false);         // false (default)
```

## Features

- **Local evaluation** - Near-zero latency after initialization
- **Real-time updates** - SSE streaming with automatic polling fallback
- **Event tracking** - Automatic batching and background flushing
- **Test support** - `forTesting()` factory for deterministic unit tests
- **TypeScript** - Full type definitions included

## Requirements

- Node.js 18+

## License

Apache-2.0
