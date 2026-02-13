export const extractCitationSource = (webResult: Record<string, unknown>): string => {
  const metaData = webResult['meta_data']

  if (metaData && typeof metaData === 'object') {
    const citationDomainName = (metaData as Record<string, unknown>)['citation_domain_name']

    if (typeof citationDomainName === 'string' && citationDomainName.trim() !== '') {
      return citationDomainName
    }
  }

  const url = webResult['url']

  if (typeof url === 'string' && url.trim() !== '') {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      // Continue to fallback values.
    }
  }

  const title = webResult['name']

  if (typeof title === 'string' && title.trim() !== '') {
    return title.trim()
  }

  return 'unknown'
}
