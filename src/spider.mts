import $ from 'jquery'

import rexSpiderManager, { REXContentSpider } from '@bric/rex-spider/spider'

export class REXPerplexityContentSpider extends REXContentSpider {
  name():string {
    return 'Perplexity'
  }

  toString():string {
    return 'REXPerplexityContentSpider'
  }

  urlMatches(url:string): boolean {
    if (url.toLowerCase() === 'https://www.perplexity.ai/') {
      return true // Login check page
    }

    if (url.toLowerCase() === 'https://www.perplexity.ai/library') {
      return true // Library page
    }

    if (url.toLowerCase().startsWith('https://www.perplexity.ai/search/')) {
      return true // Conversation page
    }

    return false
  }

  fetchResults() {
    console.log('[perplexity] fetchResults')

    window.setTimeout(() => {
      console.log(`[${this.name()}]: fetchResults... ${window.location.href.toLowerCase()}`)

      if (window.location.href.toLowerCase() === 'https://www.perplexity.ai/') {
        console.log(`[${this.name()}]: CHECKING LOGIN...`)
        console.log($('div[data-testid="login-modal"]').length)

        if ($('div[data-testid="login-modal"]').length > 0) { // Logged in...
          console.log(`[${this.name()}]: Sending needs login...`)
          chrome.runtime.sendMessage({
            messageType: 'spiderLoginResults',
            spiderName: this.name(),
            loggedIn: false
          })
        } else {
          console.log(`[${this.name()}]: Sending needs NO login...`)
          chrome.runtime.sendMessage({
            messageType: 'spiderLoginResults',
            spiderName: this.name(),
            loggedIn: true
          })
        }
        return
      } else if (window.location.href.toLowerCase() === 'https://www.perplexity.ai/library') {
        console.log(`${this.name()}: Looking for links...`)
        const urls:string[] = []

        window.setTimeout(() => {
          $('a').each((index, item) => {
            const href = $(item).attr('href')

            console.log(`${this.name()}: checking ${href}...`)

            if (href !== undefined && href.startsWith('/search/')) {
              urls.push(`https://www.perplexity.ai${href}`)
            }
          })

          chrome.runtime.sendMessage({
            messageType: 'spiderSources',
            spiderName: this.name(),
            urls
          })
        }, 2000)

        return
      } else if (window.location.href.toLowerCase().startsWith('https://www.perplexity.ai/search/')) {
        const conversation:any[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any

        $('.group/query').each((index, item) => {
          $(item).find('.select-text').each((turnIndex, turn) => {
            conversation.push({
              speaker: 'user',
              content: $(turn).text(),
            })
          })
        })

        $('.prose').each((index, item) => {
          $(item).find('.select-text').each((turnIndex, turn) => {
            conversation.push({
              speaker: 'user',
              content: $(turn).html(),
            })
          })
        })

        chrome.runtime.sendMessage({
          messageType: 'spiderResults',
          spiderName: this.name(),
          payload: {
            conversation
          }
        })

        return
      }
    }, 1000)
  }
}

const spider = new REXPerplexityContentSpider()
rexSpiderManager.registerSpider(spider)

export default spider
