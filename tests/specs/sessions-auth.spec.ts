// @ts-nocheck

import { test, expect } from './fixtures.js'

test.describe.configure({ mode: 'serial' })

const startupDelay = 2500

// Real values captured from a live migrated account on 2026-08-22. Perplexity
// now requires an x-pplx-account header on thread endpoints; requests without
// it see an empty account (list endpoints return [], detail returns
// VIEW_THREAD_NOT_ALLOWED). Slug and uuid are the same string on Sessions
// threads.
const ACCOUNT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const THREAD_SLUG = '068e2f71-dc5c-4b4f-b3ef-4906bd8d73f0'
const THREAD_UPDATED = '2026-08-22T13:15:18.730943'

const listingItem = {
  slug: THREAD_SLUG,
  uuid: THREAD_SLUG,
  context_uuid: 'e5d9f354-02ab-4e95-a43e-d291be5faed3',
  title: 'current events in Vietnam today',
  last_query_datetime: THREAD_UPDATED,
  mode: 'SEARCH',
  status: 'COMPLETED'
}

const detailResponse = {
  status: 'success',
  entries: [{
    backend_uuid: THREAD_SLUG,
    thread_url_slug: THREAD_SLUG,
    uuid: 'entry-uuid-1',
    step_type: 'ASK',
    author_username: 'test-user',
    user_selected_model: 'test-model',
    query_str: 'current events in Vietnam today',
    entry_created_datetime: THREAD_UPDATED,
    entry_updated_datetime: THREAD_UPDATED,
    blocks: [{
      intended_usage: 'ask_text',
      markdown_block: { answer: 'Test answer content.' }
    }]
  }]
}

// Installs a fetch stub inside the service worker. The account id is offered
// through every acquisition channel the implementation might use (response
// header echo, homepage HTML, session endpoint) when cfg.accountAvailable is
// true, and through none of them when false. Assertions pin the outcome
// (thread requests carry the header), not the acquisition mechanism.
const installFetchStub = (cfg) => {
  self['__requests'] = []
  self['__dispatchedEvents'] = []

  self.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    const headers = (init && init.headers) || {}

    self['__requests'].push({ url, method: (init && init.method) || 'GET', headers })

    const jsonResponse = (body, extraHeaders) => new Response(JSON.stringify(body), {
      status: 200,
      headers: Object.assign({ 'content-type': 'application/json' }, extraHeaders || {})
    })

    const accountEcho = cfg.accountAvailable ? { 'x-pplx-account-used': cfg.accountId } : {}
    const authenticated = headers['x-pplx-account'] === cfg.accountId

    if (url.includes('list_recent')) {
      return jsonResponse(authenticated ? cfg.listing : [], accountEcho)
    }

    if (url.includes('list_ask_threads')) {
      return jsonResponse(authenticated ? cfg.listing : [], accountEcho)
    }

    if (url.includes('/rest/thread/')) {
      if (authenticated) {
        return jsonResponse(cfg.detail, accountEcho)
      }

      return new Response(JSON.stringify({ detail: { error_code: 'VIEW_THREAD_NOT_ALLOWED' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      })
    }

    if (url === 'https://www.perplexity.ai/' || url === 'https://www.perplexity.ai') {
      const marker = cfg.accountAvailable ? `"account_uuid":"${cfg.accountId}"` : ''
      return new Response(`<html><body><script>${marker}</script></body></html>`, {
        status: 200,
        headers: Object.assign({ 'content-type': 'text/html' }, accountEcho)
      })
    }

    if (url.includes('/api/auth/session')) {
      return jsonResponse(cfg.accountAvailable ? { account_uuid: cfg.accountId } : {}, accountEcho)
    }

    return jsonResponse([])
  }
}

const runCheckNeedsUpdate = () => {
  const plugin = self['rexSpiderPerplexityPlugin']

  plugin.sleepDelayMs = 5

  return plugin.checkNeedsUpdate()
    .then((needsUpdate) => new Promise((resolve) => {
      // dispatchCompletionEvent delays 1100ms for PDK's persist debounce;
      // wait it out so completion events are captured before reading.
      setTimeout(() => resolve(needsUpdate), 1500)
    }))
}

const collectResults = () => {
  return new Promise((resolve) => {
    const message = {
      messageType: 'fetchValue',
      key: `perplexity-${self['__threadSlug']}-last-update`
    }

    self['rexCorePlugin'].handleMessage(message, null, (storedLastUpdate) => {
      resolve({
        requests: self['__requests'],
        storedLastUpdate,
        events: (self['__dispatchedEvents'] || []).map((event) => ({
          name: event.name,
          eventName: event.event_name || null,
          identifier: event.identifier || null,
          accountCompleteReason: event.event_details ? (event.event_details.reason || null) : null
        }))
      })
    })
  })
}

test.describe('REX Spider Perplexity - Sessions API authentication', () => {
  test('Attaches x-pplx-account to index and detail fetches and captures the conversation', async ({ serviceWorker }) => {
    await new Promise((resolve) => setTimeout(resolve, startupDelay))

    await serviceWorker.evaluate(installFetchStub, {
      accountAvailable: true,
      accountId: ACCOUNT_ID,
      listing: [listingItem],
      detail: detailResponse
    })

    await serviceWorker.evaluate((slug) => { self['__threadSlug'] = slug }, THREAD_SLUG)

    await serviceWorker.evaluate(runCheckNeedsUpdate)

    const results = await serviceWorker.evaluate(collectResults)

    const indexRequests = results.requests.filter((request) => request.url.includes('list_ask_threads'))
    const detailRequests = results.requests.filter((request) => request.url.includes(`/rest/thread/${THREAD_SLUG}`))

    expect(indexRequests.length).toBeGreaterThan(0)
    expect(detailRequests.length).toBeGreaterThan(0)

    for (const request of [...indexRequests, ...detailRequests]) {
      expect(request.headers['x-pplx-account']).toBe(ACCOUNT_ID)
    }

    // Value-level assertion at the destination: the dedup timestamp persisted
    // through rex-core matches the thread's update time, so the conversation
    // was parsed and recorded, not merely fetched.
    expect(results.storedLastUpdate).toBe(Date.parse(THREAD_UPDATED))

    const conversationEvents = results.events.filter((event) => event.name === 'rex-conversation')
    expect(conversationEvents.length).toBe(1)
    expect(conversationEvents[0].identifier).toBe(THREAD_SLUG)

    // Premise for the fail-closed test below: account-complete IS observable
    // through this capture path when it legitimately fires (one listing page
    // smaller than page size means the account was fully enumerated).
    const accountComplete = results.events.filter((event) => event.eventName === 'rex-spider-perplexity-account-complete')
    expect(accountComplete.length).toBe(1)
    expect(accountComplete[0].accountCompleteReason).toBe('exhausted')
  })

  test('Never signals account-complete when no account id is available', async ({ serviceWorker }) => {
    await new Promise((resolve) => setTimeout(resolve, startupDelay))

    await serviceWorker.evaluate(installFetchStub, {
      accountAvailable: false,
      accountId: ACCOUNT_ID,
      listing: [listingItem],
      detail: detailResponse
    })

    await serviceWorker.evaluate((slug) => { self['__threadSlug'] = slug }, THREAD_SLUG)

    await serviceWorker.evaluate(runCheckNeedsUpdate)

    const results = await serviceWorker.evaluate(collectResults)

    // The per-run completion event still fires (existing semantics: it fires
    // on every exit path), which also proves events were being captured while
    // account-complete stayed correctly silent.
    const runComplete = results.events.filter((event) => event.eventName === 'rex-spider-perplexity-complete')
    expect(runComplete.length).toBe(1)

    const accountComplete = results.events.filter((event) => event.eventName === 'rex-spider-perplexity-account-complete')
    expect(accountComplete.length).toBe(0)

    expect(results.storedLastUpdate).toBeNull()
  })

  test('checkLogin resolves true through the account header', async ({ serviceWorker }) => {
    await new Promise((resolve) => setTimeout(resolve, startupDelay))

    await serviceWorker.evaluate(installFetchStub, {
      accountAvailable: true,
      accountId: ACCOUNT_ID,
      listing: [listingItem],
      detail: detailResponse
    })

    const loggedIn = await serviceWorker.evaluate(() => self['rexSpiderPerplexityPlugin'].checkLogin())

    expect(loggedIn).toBe(true)
  })
})
