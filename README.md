# rex-spider-perplexity

Rex spider module for Perplexity-specific automated interactions.

## Overview

**rex-spider-perplexity** extends the rex-spider framework with Perplexity-specific automation capabilities.

## Configuration

This module uses the `spider` configuration section from the backend config.

### Schema

See [rex-spider](https://github.com/bric-digital/rex-spider) for configuration details.

### Example

```json
{
  "spider": {
    "enabled": true
  }
}
```

When `spider.enabled` is `true`, this module will be active on Perplexity pages.

## Installation

Add to your extension's `package.json` dependencies:

```json
{
  "dependencies": {
    "@bric/rex-spider-perplexity": "github:bric-digital/rex-spider-perplexity#main"
  }
}
```

Then run `npm install`.

## Module Context Exports

- `./extension` - Extension UI context
- `./browser` - Browser/content script context
- `./service-worker` - Service worker context

## License

Apache 2.0
