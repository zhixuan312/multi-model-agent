export function isReviewTransportFailure(
  r: { status?: string },
): boolean {
  return r.status === 'api_error' || r.status === 'network_error' || r.status === 'timeout';
}
