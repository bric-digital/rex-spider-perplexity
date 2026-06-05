import { test, expect } from './fixtures.js';

test.describe.configure({ mode: 'serial' });

const startupDelay = 2500

const linksPageURL = 'http://localhost:3000/hashes/links.html'

test.describe('REX Spider Perplexity - Parsing Content', () => {
  test('Respond to missing citation_domain_url nodes', async ({ serviceWorker }) => {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        serviceWorker.evaluate(async () => {
          return new Promise<any>((testResolve) => {
            const url = chrome.runtime.getURL('data/missing_citation_domain/us-equity-markets-advanced-mon-boRTj0zdSASYXtSg1J1dDw.json')

            fetch(url)
              .then((convoResponse) => {
                if (convoResponse.ok) {
                  convoResponse.json().then((result) => {
                    if (result.status === 'success') {
                      if (self.rexSpiderPerplexityPlugin !== undefined) {
                        self.rexSpiderPerplexityPlugin.parseConversation(result).then((payload) => {
                          // TODO: Write test case that verifies that results are valid.

                          testResolve(payload)
                        })
                      } else {
                         testResolve({
                          'error': `Missing rexSpiderPerplexityPlugin.`,
                          'self': JSON.stringify(self)
                        })
                      }
                    } else {
                       testResolve({'error': `Error parsing JSON: ${result}.`})
                    }
                  })
                } else {
                  testResolve({'error': 'Error fetching test content.'})
                }
              })
              .catch((error) => {
                console.log(`error: ${error}`)

                testResolve(error)
              })
          })
        }).then((payload) => {
          expect(payload).toBeNull() // Replace with checks once tests are finished.

          resolve()
        })
      }, 1000)
    })
  })
})
