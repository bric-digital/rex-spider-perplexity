import { extractCitationSource } from './citation-utils.mjs'

declare global {
  interface Window {
    rexPerplexityTestUtils?: {
      extractCitationSource: (webResult: Record<string, unknown>) => string
    }
  }
}

window.rexPerplexityTestUtils = {
  extractCitationSource
}

export {}
