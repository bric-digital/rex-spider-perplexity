// @ts-nocheck

// Implements the necessary functionality to load the REX modules into the 
// extension background service worker context.

import rexCorePlugin, { REXServiceWorkerModule, registerREXModule } from '@bric/rex-core/service-worker'
import rexSpiderPlugin from '@bric/rex-spider/service-worker'
import rexSpiderPerplexityPlugin from '@bric/rex-spider-perplexity/service-worker'

// Captures every dispatched event through the public module contract so specs
// can assert on what was dispatched without reaching into rex-core internals.
class EventCaptureModule extends REXServiceWorkerModule {
  moduleName () {
    return 'TestEventCapture'
  }

  setup () { }

  logEvent (event) {
    self['__dispatchedEvents'] = self['__dispatchedEvents'] || []
    self['__dispatchedEvents'].push(event)
  }
}

registerREXModule(new EventCaptureModule())

console.log(`Imported ${rexCorePlugin} into service worker context...`)
console.log(`Imported ${rexSpiderPlugin} into service worker context...`)
console.log(`Imported ${rexSpiderPerplexityPlugin} into service worker context...`)

self['rexCorePlugin'] = rexCorePlugin
self['rexSpiderPlugin'] = rexSpiderPlugin
self['rexSpiderPerplexityPlugin'] = rexSpiderPerplexityPlugin

rexCorePlugin.setup()
