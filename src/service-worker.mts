import { Conversation, Turn, DateString, Citation, Search, Result } from '@bric/extension-conversation/types'

import { dispatchEvent } from '@bric/webmunk-core/service-worker'
import webmunkSpiderPlugin, { WebmunkSpider } from '@bric/webmunk-spider/service-worker'

export class WebmunkPerplexitySpider extends WebmunkSpider {
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

  checkNeedsUpdate(): Promise<boolean> {
    console.log('[perplexity] returning checkNeedsUpdate promise...')

    return new Promise<boolean>((resolve) => {
      // Assuming logged in...

      console.log('[perplexity] from service worker')
      const indexUrl = 'https://www.perplexity.ai/rest/thread/list_recent?version=2.18&source=default'

      console.log(`[perplexity] index: ${indexUrl}`)

      fetch(indexUrl)
        .then((response: Response) => {
          console.log(`[perplexity] index ok?: ${response.ok}`)

          if (response.ok) {
            let toCrawl = []

            response.json().then((perplexityList) => {
              console.log(`[perplexity] perplexityList`)
              console.log(perplexityList)

              for (const convo of perplexityList) {
                if (convo.link !== undefined) {
                  const tokens = convo.link.split('/')

                  if (tokens[1] === 'search') {
                    const fullUrl = `https://www.perplexity.ai/rest/thread/${tokens[2]}?with_parent_info=true&with_schematized_response=true&version=2.18&source=default&limit=10&offset=0&from_first=true&supported_block_use_cases=answer_modes&supported_block_use_cases=media_items&supported_block_use_cases=knowledge_cards&supported_block_use_cases=inline_entity_cards&supported_block_use_cases=place_widgets&supported_block_use_cases=finance_widgets&supported_block_use_cases=prediction_market_widgets&supported_block_use_cases=sports_widgets&supported_block_use_cases=flight_status_widgets&supported_block_use_cases=news_widgets&supported_block_use_cases=shopping_widgets&supported_block_use_cases=jobs_widgets&supported_block_use_cases=search_result_widgets&supported_block_use_cases=inline_images&supported_block_use_cases=inline_assets&supported_block_use_cases=placeholder_cards&supported_block_use_cases=diff_blocks&supported_block_use_cases=inline_knowledge_cards&supported_block_use_cases=entity_group_v2&supported_block_use_cases=refinement_filters&supported_block_use_cases=canvas_mode&supported_block_use_cases=maps_preview&supported_block_use_cases=answer_tabs&supported_block_use_cases=price_comparison_widgets&supported_block_use_cases=preserve_latex&supported_block_use_cases=generic_onboarding_widgets&supported_block_use_cases=in_context_suggestions`

                    console.log(`[perplexity] add: ${fullUrl}`)

                    toCrawl.push(fullUrl)
                  }
                }
              }

              const fetchConvo = () => {
                if (toCrawl.length == 0) {
                  resolve(false)
                } else {
                  const nextUrl = toCrawl.pop()

                  console.log(`[perplexity] crawl: ${nextUrl}`)

                  fetch(nextUrl)
                    .then((convoResponse: Response) => {
                      if (convoResponse.ok) {
                        convoResponse.json().then((result) => {
                          console.log(`[perplexity] ok/json: ${nextUrl}`)
                          console.log(result)

                          if (result.status === 'success') {
                            let firstWhen = new Date(result.entries[0]['entry_updated_datetime'])

                            console.log(`parse: ${result.entries[0]['entry_updated_datetime']}`)

                            let firstWhenString:DateString = new DateString(result.entries[0]['entry_updated_datetime'])

                            let conversation:Conversation = {
                              turns:[],
                              platform: 'perplexity',
                              identifier:result.entries[0]['thread_url_slug'],
                              started:firstWhenString,
                              ended:firstWhenString,
                              metadata: null
                            }

                            let entryIndex = 0

                            for (let entry of result.entries) { // Each entry is a question and answer pair
                              const when = new Date(entry.updated_us / 1000)
                              console.log(`when ${when} -- ${entry.updated_us}`)

                              const whenString = new DateString(when.toISOString())

                              if (entryIndex === 0) {
                                firstWhen = when
                                firstWhenString = whenString

                                conversation['started'] = whenString
                              }

                              conversation['ended'] = whenString

                              const stepsContent = JSON.parse(entry.text) as []

                              let responseMetadata = {}
                              let citations:Citation[] = []
                              let search:Search = {
                                platform: 'perplexity',
                                'query*': '',
                                type: '',
                                results: [],
                              }

                              for (const step of stepsContent) {
                                if (step['step_type'] === 'INITIAL_QUERY') {
                                  let turn:Turn = {
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
                                  for (let query of step['content']['queries'] as []) {
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

                                  for (let webResult of step['content']['web_results'] as []) {
                                    let result:Result = {
                                      title: webResult['name'],
                                      url: webResult['url'],
                                      preview: webResult['snippet'],
                                      index,
                                      metadata: webResult
                                    }

                                    search.results.push(result)

                                    let citation:Citation = {
                                      title: webResult['name'],
                                      url: webResult['url'],
                                      source: webResult['meta_data']['citation_domain_name']
                                    }

                                    citations.push(citation)
                                  }

                                  responseMetadata['SEARCH_RESULTS'] = step

                                } else if (step['step_type'] === 'FINAL') {
                                  responseMetadata['FINAL'] = step

                                  const answer = JSON.parse(step['content']['answer'])

                                  let turn:Turn = {
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
                            }

                            let payload:any = conversation

                            payload['name'] = 'rex-conversation'
                            payload['date'] = firstWhen

                            // TODO: add check to see if conversation is actually updated...

                            dispatchEvent(payload)

                            console.log(`[perplexity] log:`)
                            console.log(payload)

                            fetchConvo()
                          } else {
                            resolve(true) // Error - fall back to DOM scraping...
                          }
                        })
                      } else {
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

console.log(`urlFilter: ${urlFilter}`)

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
    console.log('[chrome.declarativeNetRequest] ' + chrome.runtime['lastError'].message)
  } else {
    console.log(`[SPIDER] ${urlFilter} installed`)

    chrome.declarativeNetRequest.getSessionRules()
      .then((rules) => {
        console.log('CONFIRM RULES')
        console.log(rules)

        chrome.declarativeNetRequest.testMatchOutcome({
          url: 'https://www.perplexity.ai/',
          type: 'sub_frame'
        })
        .then((result) => {
          console.log('TEST RESULT')
          console.log(result)
        })
      })
  }
})

chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(function (matchedRule) {
  console.log('[SPIDER PERPLEX] rule matched:', matchedRule);
});

const perplexitySpider = new WebmunkPerplexitySpider()

webmunkSpiderPlugin.registerSpider(perplexitySpider)

export default perplexitySpider
