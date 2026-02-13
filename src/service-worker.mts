import { Conversation, Turn, DateString, Citation, Search, Result } from '@bric/rex-types/types'

import rexCorePlugin, { EventPayload, dispatchEvent } from '@bric/rex-core/service-worker'
import rexSpiderPlugin, { REXSpider } from '@bric/rex-spider/service-worker'

export class REXPerplexitySpider extends REXSpider {
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

  checkNeedsUpdate(): Promise<boolean> {
    console.log(`[rex-spider-perplexity] checkNeedsUpdate`)

    return new Promise<boolean>((resolve) => {
      // Assuming logged in...

      const indexUrl = 'https://www.perplexity.ai/rest/thread/list_recent?version=2.18&source=default'

      fetch(indexUrl)
        .then((response: Response) => {
          if (response.ok) {
            const toCrawl = []

            response.json().then((perplexityList) => {
              console.log(`[rex-spider-perplexity] Index content:`)
              console.log(perplexityList)

              for (const convo of perplexityList) {
                if (convo.link !== undefined) {
                  const tokens = convo.link.split('/')

                  if (tokens[1] === 'search') {
                    const fullUrl = `https://www.perplexity.ai/rest/thread/${tokens[2]}?with_parent_info=true&with_schematized_response=true&version=2.18&source=default&limit=10&offset=0&from_first=true&supported_block_use_cases=answer_modes&supported_block_use_cases=media_items&supported_block_use_cases=knowledge_cards&supported_block_use_cases=inline_entity_cards&supported_block_use_cases=place_widgets&supported_block_use_cases=finance_widgets&supported_block_use_cases=prediction_market_widgets&supported_block_use_cases=sports_widgets&supported_block_use_cases=flight_status_widgets&supported_block_use_cases=news_widgets&supported_block_use_cases=shopping_widgets&supported_block_use_cases=jobs_widgets&supported_block_use_cases=search_result_widgets&supported_block_use_cases=inline_images&supported_block_use_cases=inline_assets&supported_block_use_cases=placeholder_cards&supported_block_use_cases=diff_blocks&supported_block_use_cases=inline_knowledge_cards&supported_block_use_cases=entity_group_v2&supported_block_use_cases=refinement_filters&supported_block_use_cases=canvas_mode&supported_block_use_cases=maps_preview&supported_block_use_cases=answer_tabs&supported_block_use_cases=price_comparison_widgets&supported_block_use_cases=preserve_latex&supported_block_use_cases=generic_onboarding_widgets&supported_block_use_cases=in_context_suggestions`

                    if (toCrawl.includes(fullUrl) === false) {
                      toCrawl.push(fullUrl)
                    }
                  }
                }
              }

              console.log(`[rex-spider-perplexity] Crawl list:`)
              console.log(toCrawl)

              const fetchConvo = () => {
                if (toCrawl.length == 0) {
                  resolve(false)
                } else {
                  const nextUrl = toCrawl.pop()

                  console.log(`[rex-spider-perplexity] Crawl: ${nextUrl}`)

                  fetch(nextUrl)
                    .then((convoResponse: Response) => {
                      if (convoResponse.ok) {
                        convoResponse.json().then((result) => {
                          if (result.status === 'success') {
                            let firstWhen = new Date(result.entries[0]['entry_updated_datetime'])

                            let latestDate = firstWhen

                            let firstWhenString:DateString = new DateString(result.entries[0]['entry_updated_datetime'])

                            const conversation:Conversation = {
                              turns:[],
                              platform: 'perplexity',
                              identifier:result.entries[0]['thread_url_slug'],
                              started:firstWhenString,
                              ended:firstWhenString,
                              metadata: null
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
                                firstWhenString = whenString

                                conversation['started'] = whenString
                              }

                              if (when > latestDate) {
                                latestDate = when
                              }

                              conversation['ended'] = whenString

                              const responseMetadata = {}

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

                                      const citation:Citation = {
                                        title: webResult['name'],
                                        url: webResult['url'],
                                        source: webResult['meta_data']['citation_domain_name']
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

                                      const citation:Citation = {
                                        title: webResult['name'],
                                        url: webResult['url'],
                                        source: webResult['meta_data']['citation_domain_name']
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

                                const storeMessage = {
                                  messageType: 'storeValue',
                                  key: lastUpdateKey,
                                  value: latestDate.valueOf()
                                }

                                rexCorePlugin.handleMessage(storeMessage, this, (response) => {
                                  console.log(`[rex-spider-perplexity] ${lastUpdateKey} = ${latestDate.valueOf()}`)
                                })
                              }

                              fetchConvo()
                            })
                          } else {
                            console.log(`[rex-spider-perplexity] Crawl failed ${nextUrl}. Content:`)
                            console.log(convoResponse)

                            resolve(true) // Error - fall back to DOM scraping...
                          }
                        })
                      } else {
                        console.log(`[rex-spider-perplexity] Crawl failed ${nextUrl}. Response:`)
                        console.log(convoResponse)

                        resolve(true) // Error - fall back to DOM scraping...
                      }
                    })
                }
              }

              fetchConvo()
            })
          } else {
            resolve(true) // Error - fall back to DOM scraping...
          }
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
  if (chrome.runtime['lastError']) {
    console.log('[rex-spider-perplexity / chrome.declarativeNetRequest] ' + chrome.runtime['lastError'].message)
  } else {
    console.log(`[rex-spider-perplexity] ${urlFilter} installed`)

    chrome.declarativeNetRequest.getSessionRules()
      .then((rules) => {
        chrome.declarativeNetRequest.testMatchOutcome({
          url: 'https://www.perplexity.ai/',
          type: 'sub_frame'
        })
        .then((result) => {

        })
      })
  }
})

chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(function (matchedRule) {
  console.log('[rex-spider-perplexity] Rule matched:', matchedRule);
});

const perplexitySpider = new REXPerplexitySpider()

rexSpiderPlugin.registerSpider(perplexitySpider)

export default perplexitySpider
