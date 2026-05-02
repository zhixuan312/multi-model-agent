const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escapeBody = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface FetchedContent {
  url: string;
  host: string;
  content: string;
}

export function wrapFetchedContent(c: FetchedContent): string {
  return `<external-content url="${escapeAttr(c.url)}" host="${escapeAttr(c.host)}" trustLevel="untrusted">${escapeBody(c.content)}</external-content>`;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export function wrapSearchResults(hits: readonly SearchHit[]): string {
  return `<external-search-results trustLevel="untrusted">${escapeBody(JSON.stringify(hits))}</external-search-results>`;
}
