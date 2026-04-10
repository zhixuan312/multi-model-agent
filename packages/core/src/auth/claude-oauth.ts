export interface ClaudeAuth {
  apiKey?: string;
  useOAuth: boolean;
}

export function getClaudeAuth(): ClaudeAuth {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return {
    apiKey: apiKey || undefined,
    useOAuth: !apiKey,
  };
}
