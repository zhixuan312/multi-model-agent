const SENSITIVE_PARAMS = ['api_key', 'mailto'];

export function redactAdapterUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const param of SENSITIVE_PARAMS) {
      if (u.searchParams.has(param)) {
        u.searchParams.set(param, 'REDACTED');
      }
    }
    return u.toString();
  } catch {
    let redacted = url;
    for (const param of SENSITIVE_PARAMS) {
      redacted = redacted.replace(
        new RegExp(`(${param}=)[^&]+`, 'g'),
        `$1REDACTED`,
      );
    }
    return redacted;
  }
}

export const RESEARCH_HTTP_TIMEOUT_MS = 15_000;
