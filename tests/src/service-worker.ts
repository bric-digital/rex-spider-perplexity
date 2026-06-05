// @ts-nocheck

// Implements the necessary functionality to load the REX modules into the 
// extension background service worker context.

import rexCorePlugin from '@bric/rex-core/service-worker'
import rexSpiderPlugin from '@bric/rex-spider/service-worker'
import rexSpiderPerplexityPlugin from '@bric/rex-spider-perplexity/service-worker'

console.log(`Imported ${rexCorePlugin} into service worker context...`)
console.log(`Imported ${rexSpiderPlugin} into service worker context...`)
console.log(`Imported ${rexSpiderPerplexityPlugin} into service worker context...`)

self['rexCorePlugin'] = rexCorePlugin
self['rexSpiderPlugin'] = rexSpiderPlugin
self['rexSpiderPerplexityPlugin'] = rexSpiderPerplexityPlugin

rexCorePlugin.setup()
