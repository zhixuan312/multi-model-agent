// Response builders for the Bun.serve handler chain. Handlers RETURN these.
const JSON_HEADERS = { 'content-type': 'application/json' } as const;

export function sendError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return new Response(
    JSON.stringify({ error: { code, message, ...(details !== undefined ? { details } : {}) } }),
    { status, headers: JSON_HEADERS },
  );
}

export function sendJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
