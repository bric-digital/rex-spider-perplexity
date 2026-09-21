import check from 'check-types'

import { Conversation, Turn, DateString, Citation, Search, REXStackOperator } from '@bric/rex-types/types'

import { EventPayload, dispatchEvent } from '@bric/rex-core/service-worker'
import rexSpiderPlugin, { REXSpider, REXSpiderCrawlResult, REXSpiderCrawlInspection } from '@bric/rex-spider/service-worker'


export class REXPerplexitySpider extends REXSpider {
  // const stringToId = function (str:string) {
  //   let id:number = str.length

  //   let multiplier = 1

  //   Array.from(str).forEach((it:string) => {
  //     id += it.charCodeAt(0) * multiplier

  //     multiplier *= 10
  //   })

  //   return id % 5000
  // }

  fetchUrls(): string[] {
    return ['https://www.perplexity.ai/library']
  }

  name(): string {
    return 'Perplexity'
  }

  identifier(): string {
    return 'perplexity'
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

  allowedUrls():string[] {
    return [
      '^https://www.perplexity.ai/rest/'
    ]
  }

  parseConversation(conversationJson: any): Promise<any | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return new Promise((resolve, reject) => {
      let firstWhen = new Date(conversationJson.entries[0]['entry_updated_datetime'])

      let latestDate = firstWhen

      const firstWhenString:DateString = new DateString(conversationJson.entries[0]['entry_updated_datetime'])

      const conversation:Conversation = {
        turns:[],
        platform: 'perplexity',
        identifier:conversationJson.entries[0]['thread_url_slug'],
        started:firstWhenString,
        ended:firstWhenString,
        metadata: conversationJson // TODO: Pull out and only populate when configured.
      }

      const entryIndex = 0

      for (const entry of conversationJson.entries) { // Each entry is a question and answer pair
        let when = new Date(entry.entry_updated_datetime)

        if (entry.updated_us !== undefined) {
          when = new Date(entry.updated_us / 1000)
        }

        const whenString = new DateString(when.toISOString())

        if (entryIndex === 0) {
          firstWhen = when

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

      conversation.ended = new DateString(latestDate)

      const payload: EventPayload = {
        name: 'rex-conversation',
        date: firstWhen,
        ...conversation
      }

      resolve(payload)
    })
  }

  pageSize(): number {
    return 20
  }

  doBackgroundCrawl():Promise<REXSpiderCrawlResult> {
    return new Promise<REXSpiderCrawlResult>((resolve) => {
      super.doBackgroundCrawl().then((crawlResult:REXSpiderCrawlResult) => {
        const crawledIds: string[] = []

        let dispatched:number = 0

        const indexUrl = 'https://www.perplexity.ai/rest/thread/list_ask_threads?version=2.18&source=default'

        const pendingCrawlIds = new REXStackOperator<string>()

        const pendingListCrawls = new REXStackOperator<number>()

        pendingListCrawls.push(0)

        pendingListCrawls.run((offset:number):Promise<void> => {
          return new Promise<void>((listResolve) => {
            const jsonBody = JSON.stringify({
              limit: this.pageSize(),
              ascending: false,
              offset: offset,
              search_term: '',
              exclude_asi: false
            })
          
            fetch(indexUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: jsonBody
            }).then((response) => {
              if (response.ok) {
                response.json().then((jsonData) => {
                  if (check.array(jsonData)) {
                    for (const item of jsonData) {
                      if (item['last_query_datetime'] !== undefined) {
                        const updated = new DateString(item['last_query_datetime'])

                        this.crawlWindowContains(updated.timestamp()).then((isContained:boolean) => {
                          if (isContained && check.string(item['slug'])) {
                            this.checkIfAlreadyTransmitted(item['slug'], updated).then((transmitted:boolean) => {
                              if (transmitted === false) {
                                pendingCrawlIds.push(item['slug'])
                              }
                            })
                          }
                        })
                      }

                      if (jsonData.length === this.pageSize()) {
                        pendingListCrawls.push(offset + this.pageSize())
                      }

                      listResolve()
                   }
                  } else {
                    this.signalCrawlComplete(-1, crawledIds, `Page failed (offset: ${offset}): Response JSON is not a list: ${JSON.stringify(jsonData)}`, false)                    

                    console.log(`[rex-spider-perplexity] Page failed (offset: ${offset}): Response JSON is not a list: ${JSON.stringify(jsonData)}`)

                    listResolve()
                  }
                })
              } else {
                this.signalCrawlComplete(-1, crawledIds, `Page failed (offset: ${offset}, status: ${response.status}).`, false)                    

                console.log(`[rex-spider-perplexity] Page failed (offset: ${offset}, status: ${response.status}).`)

                listResolve()
              }
            }).catch((err) => {
              this.signalCrawlComplete(-1, crawledIds, `Error fetching page (offset: ${offset}, error: ${err}).`, false)                    

              console.log(`[rex-spider-perplexity] Error fetching page (offset: ${offset}, error: ${err}).`)

              listResolve()
            })
          })
        }).then(() => {
          pendingCrawlIds.run((convoId:string):Promise<void> => {
            return new Promise<void>((convoResolve) => {
              const convoUrl = new URL(`https://www.perplexity.ai/rest/thread/${convoId}`)
              convoUrl.searchParams.append('with_parent_info', 'true')
              convoUrl.searchParams.append('with_schematized_response', 'true')
              convoUrl.searchParams.append('version', '2.18')
              convoUrl.searchParams.append('source', 'default')
              convoUrl.searchParams.append('limit', '10') // TODO: Investigate
              convoUrl.searchParams.append('offset', '0') // TODO: Investigate
              convoUrl.searchParams.append('from_first', 'true')
              convoUrl.searchParams.append('supported_block_use_cases', 'answer_modes')
              convoUrl.searchParams.append('supported_block_use_cases', 'media_items')
              convoUrl.searchParams.append('supported_block_use_cases', 'knowledge_cards')
              convoUrl.searchParams.append('supported_block_use_cases', 'inline_entity_cards')
              convoUrl.searchParams.append('supported_block_use_cases', 'place_widgets')
              convoUrl.searchParams.append('supported_block_use_cases', 'finance_widgets')
              convoUrl.searchParams.append('supported_block_use_cases', 'prediction_market_widgets')
              convoUrl.searchParams.append('supported_block_use_cases', 'sports_widgets')
              convoUrl.searchParams.append('supported_block_use_cases', 'flight_status_widgets')
              convoUrl.searchParams.append('supported_block_use_cases', 'news_widgets')
              convoUrl.searchParams.append('supported_block_use_cases', 'shopping_widgets')
              convoUrl.searchParams.append('supported_block_use_cases', 'jobs_widgets')
              convoUrl.searchParams.append('supported_block_use_cases', 'search_result_widgets')
              convoUrl.searchParams.append('supported_block_use_cases', 'inline_images')
              convoUrl.searchParams.append('supported_block_use_cases', 'inline_assets')
              convoUrl.searchParams.append('supported_block_use_cases', 'placeholder_cards')
              convoUrl.searchParams.append('supported_block_use_cases', 'diff_blocks')
              convoUrl.searchParams.append('supported_block_use_cases', 'inline_knowledge_cards')
              convoUrl.searchParams.append('supported_block_use_cases', 'entity_group_v2')
              convoUrl.searchParams.append('supported_block_use_cases', 'refinement_filters')
              convoUrl.searchParams.append('supported_block_use_cases', 'canvas_mode')
              convoUrl.searchParams.append('supported_block_use_cases', 'maps_preview')
              convoUrl.searchParams.append('supported_block_use_cases', 'answer_tabs')
              convoUrl.searchParams.append('supported_block_use_cases', 'price_comparison_widgets')
              convoUrl.searchParams.append('supported_block_use_cases', 'preserve_latex')
              convoUrl.searchParams.append('supported_block_use_cases', 'generic_onboarding_widgets')
              convoUrl.searchParams.append('supported_block_use_cases', 'in_context_suggestions')

              const convoUrlStr = convoUrl.href

              console.log(`[rex-spider-perplexity] Crawl: ${convoUrlStr}`)

              fetch(convoUrlStr).then((convoResponse: Response) => {
                if (convoResponse.ok) {
                  convoResponse.json().then((jsonData) => {
                    if (jsonData.status === 'success') {
                      this.parseConversation(jsonData).then((conversation) => {
                        if (conversation !== null) {
                          const payload: EventPayload = {
                            name: 'rex-conversation',
                            date: conversation.started.value.epochMilliseconds,
                            ...conversation
                          }

                          dispatchEvent(payload)

                          dispatched += 1

                          this.logTransmitted(conversation.id, conversation.lookupDate).then(() => {
                            setTimeout(() => {
                              convoResolve()
                            }, this.fetchCrawlDelay())
                          })
                        } else {
                          console.log(`[rex-spider-perplexity] Received null conversation.`)

                          setTimeout(() => {
                            convoResolve()
                          }, this.fetchCrawlDelay())
                        }
                      })
                    } else {
                      console.log(`[rex-spider-perplexity] Did not receive success on conversation fetch: ${JSON.stringify(jsonData)}.`)

                      setTimeout(() => {
                        convoResolve()
                      }, this.fetchCrawlDelay())
                    }
                  }).catch((err) => {
                    console.log(`[rex-spider-perplexity] Error fetching conversation JSON at ${convoUrlStr}: ${err}.`)

                    setTimeout(() => {
                      convoResolve()
                    }, this.fetchCrawlDelay())
                  })
                } else {
                  console.log(`[rex-spider-perplexity] Error fetching conversation at ${convoUrlStr} (status code: ${convoResponse.status}).`)

                  setTimeout(() => {
                    convoResolve()
                  }, this.fetchCrawlDelay())
                }
              }).catch((err) => {
                console.log(`[rex-spider-perplexity] Error fetching conversation at ${convoUrlStr}: ${err}.`)

                setTimeout(() => {
                  convoResolve()
                }, this.fetchCrawlDelay())
              })
            })
          }).then(() => {
            resolve(crawlResult)
          })
        })
      })
    })
  }
}

const perplexitySpider = new REXPerplexitySpider()

rexSpiderPlugin.registerSpider(perplexitySpider)

export default perplexitySpider
