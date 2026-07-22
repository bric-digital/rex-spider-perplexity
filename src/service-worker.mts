import { Conversation, Turn, DateString, Citation, Search, Result } from '@bric/rex-types/types'

import rexCorePlugin, { EventPayload, dispatchEvent } from '@bric/rex-core/service-worker'
import rexSpiderPlugin, { REXSpider } from '@bric/rex-spider/service-worker'

import { CrawlTarget, shouldCrawl } from './crawl-target.mjs'

export class REXPerplexitySpider extends REXSpider {
  sleepDelayMs:number = 10000
  lookbackDays:number = 30
  maxIndexPages:number = 50
  syncing:boolean = false
  lastSync:number = 0
  syncPeriod:number = 300000
  // Whether routine per-run *-complete events are emitted (config
  // spider.perplexity.emit_run_complete). Watchdog-recovered completions are
  // always emitted regardless.
  emitRunComplete:boolean = true
  // Guards dispatchCompletionEvent against double-fire from the watchdog
  // racing a natural-path terminal branch. Reset at the top of each
  // checkNeedsUpdate run.
  private completed:boolean = false

  constructor() {
    super()

    // Override sleepDelayMs / lookbackDays / maxIndexPages from server config if provided.
    rexCorePlugin.fetchConfiguration()
      .then((config) => {
        const spiderConfig = (config as Record<string, any>)?.spider?.perplexity // eslint-disable-line @typescript-eslint/no-explicit-any
        const configuredDelay = spiderConfig?.sleep_delay_ms
        if (typeof configuredDelay === 'number') {
          this.sleepDelayMs = configuredDelay
        }
        const configuredLookback = spiderConfig?.lookback_days
        if (typeof configuredLookback === 'number') {
          this.lookbackDays = configuredLookback
        }
        const configuredMaxPages = spiderConfig?.max_index_pages
        if (typeof configuredMaxPages === 'number') {
          this.maxIndexPages = configuredMaxPages
        }
        const configuredEmitRunComplete = spiderConfig?.emit_run_complete
        if (typeof configuredEmitRunComplete === 'boolean') {
          this.emitRunComplete = configuredEmitRunComplete
        }
      })
      .catch((err) => console.warn('[rex-spider-perplexity] Failed to read spider config:', err))
  }

  private dispatchCompletionEvent(crawledCount: number, accountCompleteReason: 'date-floor' | 'exhausted' | null = null, recovered: boolean = false): void {
    if (this.completed) return
    this.completed = true
    // Delay mirrors the rex-history completion pattern: waits for PDK's
    // persist debounce to expire so queued events flush before the signal.
    setTimeout(() => {
      // The per-run event fires on every exit path including errors and
      // skips; deployments that only consume account-complete can silence it
      // via config spider.perplexity.emit_run_complete: false. A completion
      // the watchdog recovered is always emitted, marked recovered_via so
      // consumers (e.g. Keystone offboarding) can treat it as terminal.
      if (recovered || this.emitRunComplete) {
        dispatchEvent({
          name: 'pdk-app-event',
          event_name: 'rex-spider-perplexity-complete',
          event_details: {
            crawled_count: crawledCount,
            date: Date.now(),
            ...(recovered ? { recovered_via: 'watchdog' } : {})
          }
        })
      }

      // Account-complete only accompanies runs that enumerated the full
      // account (index paging ended at the cutoff or ran out of items, and
      // every queued thread was captured).
      if (accountCompleteReason !== null) {
        this.signalAccountComplete({
          reason: accountCompleteReason,
          crawled_count: crawledCount
        })
      }
    }, 1100)
  }

  fetchUrls(): string[] {
    return ['https://www.perplexity.ai/library']
  }

  name(): string {
    return 'Perplexity'
  }

  loginUrl(): string {
    return 'https://www.perplexity.ai/'
  }

  fetchInitialUrls(): string[] {
    return ['https://www.perplexity.ai/library/']
  }

  checkLogin(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const indexUrl = 'https://www.perplexity.ai/rest/thread/list_recent?version=2.18&source=default'

      fetch(indexUrl)
        .then((response: Response) => {
          if (response.ok) {
            response.json().then((perplexityList) => {
              if (perplexityList.length > 0) {
                resolve(true)
              } else {
                resolve(false)
              }
            })
          } else {
            resolve(false)
          }
        })
    })
  }

  private fetchLastUpdate(conversationId: string): Promise<number | null> {
    return new Promise((resolve) => {
      const key = `perplexity-${conversationId}-last-update`
      rexCorePlugin.handleMessage({ messageType: 'fetchValue', key }, this, (response) => {
        if (typeof response === 'number') {
          resolve(response)
        } else {
          resolve(null)
        }
      })
    })
  }

  private storeLastUpdate(conversationId: string, listingUpdateMs: number): Promise<void> {
    return new Promise((resolve) => {
      const key = `perplexity-${conversationId}-last-update`
      rexCorePlugin.handleMessage(
        { messageType: 'storeValue', key, value: listingUpdateMs },
        this,
        () => resolve()
      )
    })
  }

  private updateTimeMs(raw: unknown): number | null {
    if (typeof raw === 'string') {
      // list_ask_threads reports naive ISO-8601 (e.g. "2026-04-21T17:51:13.021534").
      const parsed = Date.parse(raw)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
    if (typeof raw === 'number') {
      // Heuristic fallback in case Perplexity ever switches to epoch numbers:
      // values below year-2100-in-seconds are treated as seconds, otherwise ms.
      if (raw < 4_102_444_800) {
        return raw * 1000
      }
      return raw
    }
    return null
  }

  private async pagingCutoff(): Promise<number> {
    let installTime: number | null = null
    try {
      const response = await chrome.runtime.sendMessage({ messageType: 'getInstallTime' })
      if (typeof response === 'number') {
        installTime = response
      }
    } catch (err) {
      console.log(`[rex-spider-perplexity] getInstallTime unavailable:`, err)
    }
    // Anchor the lookback window at install time so that as the study runs, the
    // pre-study buffer stays fixed at (install - lookback_days). Conversations
    // updated between install and now are always included. Fall back to
    // (now - lookback_days) when install time isn't known.
    const anchor = installTime !== null ? installTime : Date.now()
    const cutoff = anchor - this.lookbackDays * 86_400_000
    console.log(`[rex-spider-perplexity] Paging cutoff: ${new Date(cutoff).toISOString()} (lookbackDays=${this.lookbackDays}, installTime=${installTime})`)
    return cutoff
  }

  private async pageIndex(cutoff: number): Promise<{ toCrawl: CrawlTarget[], firstPageFailed: boolean, endReason: 'date-floor' | 'exhausted' | null }> {
    // Perplexity's library page uses list_ask_threads (POST, offset/limit in JSON body)
    // for its infinite scroll. list_recent (used by the sidebar) does not paginate.
    const pageSize = 20
    const indexUrl = 'https://www.perplexity.ai/rest/thread/list_ask_threads?version=2.18&source=default'
    const toCrawl: CrawlTarget[] = []

    let offset = 0
    let pageIndex = 0
    let stop = false

    // Why paging ended: 'date-floor' (crossed the cutoff) or 'exhausted'
    // (no more items) both mean the whole account was enumerated. null means
    // it ended early — maxIndexPages cap or a failed page — so completion of
    // this run does NOT imply the account is fully collected.
    let endReason: 'date-floor' | 'exhausted' | null = null

    while (!stop && pageIndex < this.maxIndexPages) {
      console.log(`[rex-spider-perplexity] Index page ${pageIndex} (offset=${offset})`)

      const response = await fetch(indexUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          limit: pageSize,
          ascending: false,
          offset,
          search_term: '',
          exclude_asi: false
        })
      })

      if (!response.ok) {
        console.log(`[rex-spider-perplexity] Index page ${pageIndex} failed (status ${response.status}).`)
        if (pageIndex === 0) {
          return { toCrawl: [], firstPageFailed: true, endReason: null }
        }
        break
      }

      const body = await response.json()
      const items: any[] = Array.isArray(body) ? body : [] // eslint-disable-line @typescript-eslint/no-explicit-any

      // Each fetched index page is progress: long paging phases (dozens of
      // pages x sleep_delay_ms) must not trip the stuck-run watchdog.
      this.noteProgress()

      for (const item of items) {
        const itemUpdateMs = this.updateTimeMs(item?.last_query_datetime)
        if (itemUpdateMs === null) continue

        if (itemUpdateMs >= cutoff) {
          // conversationId MUST equal conversation.identifier used by the detail parser
          // (thread_url_slug) so that the dedup key `perplexity-${id}-last-update` is the
          // same on both the pre-fetch shouldCrawl check and the post-parse store.
          const threadId = item?.slug
          if (typeof threadId === 'string' && threadId.length > 0) {
            const stored = await this.fetchLastUpdate(threadId)
            if (!shouldCrawl(itemUpdateMs, stored)) {
              console.log(`[rex-spider-perplexity] Skipping ${threadId} — listing update_time (${itemUpdateMs}) not newer than stored (${stored})`)
              continue
            }
            const fullUrl = `https://www.perplexity.ai/rest/thread/${threadId}?with_parent_info=true&with_schematized_response=true&version=2.18&source=default&limit=10&offset=0&from_first=true&supported_block_use_cases=answer_modes&supported_block_use_cases=media_items&supported_block_use_cases=knowledge_cards&supported_block_use_cases=inline_entity_cards&supported_block_use_cases=place_widgets&supported_block_use_cases=finance_widgets&supported_block_use_cases=prediction_market_widgets&supported_block_use_cases=sports_widgets&supported_block_use_cases=flight_status_widgets&supported_block_use_cases=news_widgets&supported_block_use_cases=shopping_widgets&supported_block_use_cases=jobs_widgets&supported_block_use_cases=search_result_widgets&supported_block_use_cases=inline_images&supported_block_use_cases=inline_assets&supported_block_use_cases=placeholder_cards&supported_block_use_cases=diff_blocks&supported_block_use_cases=inline_knowledge_cards&supported_block_use_cases=entity_group_v2&supported_block_use_cases=refinement_filters&supported_block_use_cases=canvas_mode&supported_block_use_cases=maps_preview&supported_block_use_cases=answer_tabs&supported_block_use_cases=price_comparison_widgets&supported_block_use_cases=preserve_latex&supported_block_use_cases=generic_onboarding_widgets&supported_block_use_cases=in_context_suggestions`
            if (!toCrawl.some((t) => t.conversationId === threadId)) {
              toCrawl.push({ url: fullUrl, listingUpdateMs: itemUpdateMs, conversationId: threadId })
            }
          }
        } else {
          // Items are newest-first (ascending:false), so the first below-cutoff item terminates the walk.
          stop = true
          endReason = 'date-floor'
          break
        }
      }

      if (items.length < pageSize) {
        if (endReason === null) {
          endReason = 'exhausted'
        }
        break
      }
      offset += pageSize
      pageIndex += 1
      if (!stop && pageIndex < this.maxIndexPages) {
        await new Promise((r) => self.setTimeout(r, this.sleepDelayMs))
      }
    }

    return { toCrawl, firstPageFailed: false, endReason }
  }

  parseConversation(conversationJson: any): Promise<any | null> { // eslint-disable-line @typescript-eslint/no-explicit-any, 
    return new Promise((resolve) => {
      console.log(`TODO: Need to bring conversation parsing logic here: ${conversationJson}.`)

      resolve(null)
    })
  }

  checkNeedsUpdate(force: boolean = false): Promise<boolean> {
    console.log(`[rex-spider-perplexity] checkNeedsUpdate (force=${force})`)

    return new Promise<boolean>((resolve) => {
      // Reset completion-idempotency flag at the top of every entry so the
      // "too soon to sync" short-circuit and full runs can each fire exactly
      // one *-complete event for that round.
      this.completed = false

      if (this.syncing) {
        console.log(`[rex-spider-perplexity] Still syncing. Skipping this round...`)
        resolve(true)

        return
      }

      const fetchLastSync = {
        messageType: 'fetchValue',
        key: 'rex-spider-perplexity-last-sync'
      }

      rexCorePlugin.handleMessage(fetchLastSync, this, (response) => {
        let timestamp = 0

        if (response !== null) {
          timestamp = response
        }

        if (!force && Date.now() < timestamp + this.syncPeriod) {
          console.log(`[rex-spider-perplexity] Too soon to sync again. Skipping this round...`)
          this.dispatchCompletionEvent(0)
          resolve(true)

          return
        }

        const storeMessage = {
          messageType: 'storeValue',
          key: 'rex-spider-perplexity-last-sync',
          value: Date.now()
        }

        rexCorePlugin.handleMessage(storeMessage, this, (response) => { // eslint-disable-line @typescript-eslint/no-unused-vars
          this.syncing = true

          // Arm the rex-spider watchdog. If the run wedges (hung fetch,
          // parser exception that escapes the catch chain, etc.), the
          // watchdog runs onTimeout below to clear `syncing`, dispatch
          // *-complete, and let offboarding proceed. The completed flag
          // on dispatchCompletionEvent prevents a double-fire if a
          // delayed natural-path branch later runs to completion.
          this.beginRun(() => {
            this.syncing = false
            // recovered=true: marked recovered_via 'watchdog' and emitted even
            // when routine per-run completes are silenced — offboarding needs it.
            this.dispatchCompletionEvent(0, null, true) // crawled count unknown from here
            resolve(true)
          })

          this.pagingCutoff()
            .then((cutoff) => this.pageIndex(cutoff))
            .then(({ toCrawl, firstPageFailed, endReason }) => {
              if (firstPageFailed) {
                console.log(`[rex-spider-perplexity] First index page failed; falling back to DOM scraping.`)
                this.syncing = false
                this.endRun()
                this.dispatchCompletionEvent(0)
                resolve(true) // Error - fall back to DOM scraping...
                return
              }

              let crawledCount = 0

              console.log(`[rex-spider-perplexity] Crawl list (${toCrawl.length} threads):`)
              console.log(toCrawl)

              const fetchConvo = () => {
                    if (toCrawl.length == 0) {
                      this.syncing = false
                      this.endRun()
                      this.dispatchCompletionEvent(crawledCount, endReason)
                      resolve(false)
                    } else {
                      self.setTimeout(() => {
                        const next = toCrawl.shift()!

                        console.log(`[rex-spider-perplexity] Crawl: ${next.url}`)

                        fetch(next.url)
                          .then((convoResponse: Response) => {
                            if (convoResponse.ok) {
                              convoResponse.json().then((result) => {
                                if (result.status === 'success') {
                                  // TODO: Move the logic below to parseConversation

                                  let firstWhen = new Date(result.entries[0]['entry_updated_datetime'])

                                    let latestDate = firstWhen

                                    const firstWhenString:DateString = new DateString(result.entries[0]['entry_updated_datetime'])

                                    const conversation:Conversation = {
                                      turns:[],
                                      platform: 'perplexity',
                                      identifier:result.entries[0]['thread_url_slug'],
                                      started:firstWhenString,
                                      ended:firstWhenString,
                                      metadata: result // TODO: Pull out and only populate when configured.
                                    }

                                    const entryIndex = 0

                                    for (const entry of result.entries) { // Each entry is a question and answer pair
                                      let when = new Date(entry.entry_updated_datetime)

                                      if (entry.updated_us !== undefined) {
                                        when = new Date(entry.updated_us / 1000)
                                      }

                                      const whenString = new DateString(when.toISOString())

                                      if (entryIndex === 0) {
                                        firstWhen = when
                                        // firstWhenString = whenString

                                        conversation['started'] = whenString
                                      }

                                      if (when > latestDate) {
                                        latestDate = when
                                      }

                                      conversation['ended'] = whenString

                                      const responseMetadata: Record<string, unknown> = {}

                                      const citations:Citation[] = []

                                      const search:Search = {
                                        platform: 'perplexity',
                                        'query*': '',
                                        type: '',
                                        results: [],
                                      }

                                      if (entry.text !== undefined) {
                                        const stepsContent = JSON.parse(entry.text) as []

                                        for (const step of stepsContent) {
                                          if (step['step_type'] === 'INITIAL_QUERY') {
                                            const turn:Turn = {
                                              speaker: entry['author_username'],
                                              when: whenString,
                                              'content*': step['content']['query'],
                                              identifier: 'uuid:',
                                              'metadata*': {
                                                INITIAL_QUERY: step
                                              }
                                            }

                                            conversation.turns.push(turn)
                                          } else if (step['step_type'] === 'SEARCH_WEB') {
                                            for (const query of step['content']['queries'] as []) {
                                              if (search['query*'] !== '') {
                                                search['query*'] += '; '
                                              }

                                              search['query*'] += query['query']

                                              if (search['type'] !== '') {
                                                search['type'] += '; '
                                              }

                                              search['type'] += query['engine']
                                            }

                                            responseMetadata['SEARCH_WEB'] = step
                                          } else if (step['step_type'] === 'SEARCH_RESULTS') {
                                            let index = 0

                                            for (const webResult of step['content']['web_results'] as []) {
                                              const result:Result = {
                                                title: webResult['name'],
                                                url: webResult['url'],
                                                preview: webResult['snippet'],
                                                index,
                                                metadata: webResult
                                              }

                                              search.results.push(result)

                                              let citationDomainName:string|undefined = undefined

                                              if (webResult['meta_data'] !== undefined) {
                                                citationDomainName = webResult['meta_data']['citation_domain_name']
                                              }

                                              if (citationDomainName === undefined) { // TODO - write test
                                                citationDomainName = 'perplexity.unknown:citation_domain_name'
                                              }

                                              const citation:Citation = {
                                                title: webResult['name'],
                                                url: webResult['url'],
                                                source: citationDomainName,
                                              }

                                              citations.push(citation)

                                              index += 1
                                            }

                                            responseMetadata['SEARCH_RESULTS'] = step

                                          } else if (step['step_type'] === 'FINAL') {
                                            responseMetadata['FINAL'] = step

                                            const answer = JSON.parse(step['content']['answer'])

                                            const turn:Turn = {
                                              speaker: `perplexity:${entry['author_username']}`,
                                              when: whenString,
                                              'content*': answer['answer'],
                                              identifier: 'uuid:',
                                              'metadata*': responseMetadata,
                                            }

                                            if (search['query*'] !== '') {
                                              turn['search'] =  search
                                            }

                                            if (citations.length > 0) {
                                              turn['citations'] =  citations
                                            }

                                            conversation.turns.push(turn)
                                          }
                                        }

                                      } else if (entry['step_type'] !== undefined) {
                                        const turn:Turn = {
                                          speaker: entry['author_username'],
                                          when: whenString,
                                          'content*': entry['query_str'],
                                          identifier: `uuid:${entry['uuid']}`,
                                          'metadata*': entry
                                        }

                                        conversation.turns.push(turn)

                                        for (const block of entry.blocks) {
                                          if (block['intended_usage'] === 'sources_answer_mode') {
                                            let index = 0

                                            for (const webResult of block['sources_mode_block']['web_results']) {
                                              const result:Result = {
                                                title: webResult['name'],
                                                url: webResult['url'],
                                                preview: webResult['snippet'],
                                                index,
                                                metadata: webResult
                                              }

                                              search.results.push(result)

                                              let citationDomainName:string|undefined = undefined

                                              if (webResult['meta_data'] !== undefined) {
                                                citationDomainName = webResult['meta_data']['citation_domain_name']
                                              }

                                              if (citationDomainName === undefined) { // TODO - write test
                                                citationDomainName = 'perplexity.unknown:citation_domain_name'
                                              }

                                              const citation:Citation = {
                                                title: webResult['name'],
                                                url: webResult['url'],
                                                source: citationDomainName
                                              }

                                              citations.push(citation)

                                              index += 1
                                            }
                                          } else if (block['intended_usage'] === 'pro_search_steps') {
                                            for (const searchStep of block['plan_block']['steps']) {
                                              if (searchStep['step_type'] === 'SEARCH_WEB') {
                                                for (const searchQuery of searchStep['search_web_content']['queries']) {
                                                  if (search['query*'] !== '') {
                                                    search['query*'] += '; '
                                                  }

                                                  search['query*'] += searchQuery['query']

                                                  if (search['type'].includes(searchQuery['engine']) === false) {
                                                    if (search['type'] !== '') {
                                                      search['type'] += '; '
                                                    }

                                                    search['type'] += searchQuery['engine']
                                                  }
                                                }
                                              }
                                            }
                                          } else if (block['intended_usage'] === 'ask_text') {
                                            const response:Turn = {
                                              speaker: `perplexity:${entry['user_selected_model']}`,
                                              when: whenString,
                                              'content*': block['markdown_block']['answer'],
                                              identifier: `uuid:${entry['uuid']}`,
                                              'metadata*': block
                                            }

                                            conversation.turns.push(response)
                                          }
                                        }

                                        if (search['query*'] !== '') {
                                          conversation.turns[conversation.turns.length - 1]['search'] =  search
                                        }

                                        if (citations.length > 0) {
                                          conversation.turns[conversation.turns.length - 1]['citations'] =  citations
                                        }
                                      }

                                      if (when > latestDate) {
                                        latestDate = when
                                      }
                                    }

                                    const lastUpdateKey = `${conversation.platform}-${conversation.identifier}-last-update`

                                    const message = {
                                      messageType: 'fetchValue',
                                      key: lastUpdateKey
                                    }

                                    rexCorePlugin.handleMessage(message, this, (response) => {
                                      let timestamp = 0

                                      if (response !== null) {
                                        timestamp = response
                                      }

                                      console.log(`[rex-spider-perplexity] TS TEST ${timestamp} <? ${latestDate.valueOf()}`)

                                      if (timestamp < latestDate.valueOf()) {
                                        const payload:EventPayload = {
                                          name: 'rex-conversation',
                                          date: firstWhen,
                                          ...conversation
                                        }

                                        console.log(`[rex-spider-perplexity] log:`)
                                        console.log(payload)

                                        dispatchEvent(payload)
                                        crawledCount += 1
                                        this.noteProgress()

                                        const storeMessage = {
                                          messageType: 'storeValue',
                                          key: lastUpdateKey,
                                          value: latestDate.valueOf()
                                        }

                                        rexCorePlugin.handleMessage(storeMessage, this, (response) => { // eslint-disable-line @typescript-eslint/no-unused-vars
                                          console.log(`[rex-spider-perplexity] ${lastUpdateKey} = ${latestDate.valueOf()}`)
                                        })
                                      }

                                    fetchConvo()
                                  })
                                } else {
                                  console.log(`[rex-spider-perplexity] Crawl failed ${next.url}. Content:`)
                                  console.log(convoResponse)

                                  this.syncing = false
                                  this.endRun()
                                  this.dispatchCompletionEvent(crawledCount)
                                  resolve(true) // Error - fall back to DOM scraping...
                                }
                              })
                            } else {
                              console.log(`[rex-spider-perplexity] Crawl failed ${next.url}. Response:`)
                              console.log(convoResponse)

                              this.syncing = false
                              this.endRun()
                              this.dispatchCompletionEvent(crawledCount)
                              resolve(true) // Error - fall back to DOM scraping...
                            }
                          })
                      }, this.sleepDelayMs)
                    }
                  }

              fetchConvo()
            })
            .catch((err) => {
              console.log(`[rex-spider-perplexity] Unexpected error during sync:`, err)
              this.syncing = false
              this.endRun()
              this.dispatchCompletionEvent(0)
              resolve(true) // Error - fall back to DOM scraping...
            })
        })
      })
    })
  }
}

const stringToId = function (str:string) {
  let id:number = str.length

  let multiplier = 1

  Array.from(str).forEach((it:string) => {
    id += it.charCodeAt(0) * multiplier

    multiplier *= 10
  })

  return id % 5000
}

const urlFilter = '||perplexity.ai/'

const stripRule = {
  id: stringToId('perplexity-strip'),
  priority: 1,
  action: {
    type: 'modifyHeaders' as const,
    responseHeaders: [
      { header: 'X-Frame-Options', operation: 'remove' as const },
      { header: 'Content-Security-Policy', operation: 'remove' as const }
    ]
  },
  condition: { urlFilter, resourceTypes: [
    'main_frame' as const,
    'sub_frame' as const,
    'stylesheet' as const,
    'script' as const,
    'image' as const,
    'font' as const,
    'object' as const,
    'xmlhttprequest' as const,
    'ping' as const,
    'csp_report' as const,
    'media' as const,
    'websocket' as const,
    'webtransport' as const,
    'webbundle' as const,
    'other' as const
  ] }
}

chrome.declarativeNetRequest.updateSessionRules({ // updateSessionRules({
  removeRuleIds: [stripRule.id],
  addRules: [stripRule]
}, () => {
  const lastError = (chrome.runtime as { lastError?: { message?: string } }).lastError
  if (lastError) {
    console.log('[rex-spider-perplexity / chrome.declarativeNetRequest] ' + lastError.message)
  } else {
    console.log(`[rex-spider-perplexity] ${urlFilter} installed`)

    chrome.declarativeNetRequest.getSessionRules()
      .then((rules) => { // eslint-disable-line @typescript-eslint/no-unused-vars
        chrome.declarativeNetRequest.testMatchOutcome({
          url: 'https://www.perplexity.ai/',
          type: 'sub_frame'
        })
        .then((result) => { // eslint-disable-line @typescript-eslint/no-unused-vars

        })
      })
  }
})

const perplexitySpider = new REXPerplexitySpider()

rexSpiderPlugin.registerSpider(perplexitySpider)

export default perplexitySpider
