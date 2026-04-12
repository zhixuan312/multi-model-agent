export type ErrorCode =
  | 'capability_missing'
  | 'agent_not_found'
  | 'context_block_not_found'
  | 'brief_too_vague'
  | 'timeout'
  | 'network_error'
  | 'api_error'
  | 'api_aborted'
  | 'max_turns'
  | 'error'
  | 'unknown';

export function retryableFor(status: string): boolean {
  return ['timeout', 'network_error', 'api_error'].includes(status);
}

export function classifyContextBlockError(err: Error): 'context_block_not_found' | 'retryable' | 'non_retryable' {
  const msg = err.message.toLowerCase();
  if (msg.includes('context block') || (msg.includes('id') && msg.includes('undefined'))) {
    if (msg.includes('not found') || msg.includes('undefined') || msg.includes('missing')) {
      return 'context_block_not_found';
    }
  }
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('503') || msg.includes('502')) {
    return 'retryable';
  }
  return 'non_retryable';
}
