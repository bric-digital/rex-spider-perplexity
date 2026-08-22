// Loaded by rex-core's browser bundle into every page (isolated world), so it
// shares the page's localStorage and can message the service worker.
//
// Perplexity's thread APIs require an x-pplx-account header naming the active
// account UUID, which the site keeps only in the page's localStorage. Relay it
// to the service worker whenever a participant visits perplexity.ai; the
// spider persists it (rex-spider-perplexity-account-id) and attaches it to its
// fetches. Keep the pattern in step with service-worker.mts.
const ACCOUNT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const relayPerplexityAccountId = (): void => {
  if (window.location.hostname.endsWith('perplexity.ai') === false) {
    return
  }

  try {
    const accountId = window.localStorage.getItem('pplx-last-active-account')

    if (accountId !== null && ACCOUNT_UUID_PATTERN.test(accountId)) {
      chrome.runtime.sendMessage({
        messageType: 'rexSpiderPerplexityAccountId',
        accountId
      }).catch(() => {
        // No listener awake; the next visit retries.
      })
    }
  } catch (error) {
    console.log('[rex-spider-perplexity] Unable to read account id:', error)
  }
}

relayPerplexityAccountId()

const perplexityAccountRelay = {
  name: 'REX Spider Perplexity (browser)'
}

export default perplexityAccountRelay
