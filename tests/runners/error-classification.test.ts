import { classifyError } from '../../packages/core/src/runners/error-classification.js';

describe('classifyError', () => {
  // ─── api_aborted branch ────────────────────────────────────────────────
  describe('api_aborted', () => {
    it('classifies Error with name="AbortError" as api_aborted', () => {
      const err = new Error('boom');
      err.name = 'AbortError';
      const { status, reason } = classifyError(err);
      expect(status).toBe('api_aborted');
      expect(reason).toMatch(/aborted/i);
    });

    it('classifies any Error whose message matches /aborted/i as api_aborted', () => {
      const { status } = classifyError(new Error('Request was aborted'));
      expect(status).toBe('api_aborted');
    });

    it('matches /aborted/i case-insensitively', () => {
      const { status } = classifyError(new Error('stream ABORTED mid-flight'));
      expect(status).toBe('api_aborted');
    });

    it('abort classification wins over an otherwise-HTTP-shaped error', () => {
      // If both abort AND status are present, abort takes precedence so an
      // abort-during-HTTP path never masquerades as an HTTP error.
      const err = Object.assign(new Error('aborted during send'), { status: 499 });
      expect(classifyError(err).status).toBe('api_aborted');
    });
  });

  // ─── network_error branch ───────────────────────────────────────────────
  describe('network_error', () => {
    it('classifies ECONNREFUSED as network_error', () => {
      const err = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
      const { status, reason } = classifyError(err);
      expect(status).toBe('network_error');
      expect(reason).toContain('ECONNREFUSED');
    });

    it('classifies ENOTFOUND as network_error', () => {
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
        code: 'ENOTFOUND',
      });
      expect(classifyError(err).status).toBe('network_error');
    });

    it('classifies any message matching /network/i as network_error', () => {
      const { status } = classifyError(new Error('network unreachable'));
      expect(status).toBe('network_error');
    });

    it('falls back to a non-empty reason when the message is empty', () => {
      const err = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
      const { reason } = classifyError(err);
      expect(reason).toBe('network error');
    });
  });

  // ─── api_error branch ──────────────────────────────────────────────────
  describe('api_error', () => {
    it('classifies errors with a numeric .status as api_error', () => {
      const err = Object.assign(new Error('Bad Request'), { status: 400 });
      const { status, reason } = classifyError(err);
      expect(status).toBe('api_error');
      expect(reason).toContain('HTTP 400');
      expect(reason).toContain('Bad Request');
    });

    it('formats api_error reason without trailing colon when message is empty', () => {
      const err = Object.assign(new Error(''), { status: 503 });
      const { reason } = classifyError(err);
      expect(reason).toBe('HTTP 503');
    });

    it('does NOT classify .status as api_error when it is a non-numeric string', () => {
      // OpenAI Responses API uses string statuses like 'completed' on
      // successful responses. A raw string `.status` must not be mistaken
      // for an HTTP error.
      const err = Object.assign(new Error('weird shape'), { status: 'completed' });
      expect(classifyError(err).status).toBe('error');
    });
  });

  // ─── error fallback branch ─────────────────────────────────────────────
  describe('error (fallback)', () => {
    it('falls back to error for a generic Error', () => {
      const { status, reason } = classifyError(new Error('something broke'));
      expect(status).toBe('error');
      expect(reason).toBe('something broke');
    });

    it('handles string throws', () => {
      const { status, reason } = classifyError('string thrown directly');
      expect(status).toBe('error');
      expect(reason).toBe('string thrown directly');
    });

    it('handles null', () => {
      const { status, reason } = classifyError(null);
      expect(status).toBe('error');
      expect(typeof reason).toBe('string');
    });

    it('handles undefined', () => {
      const { status, reason } = classifyError(undefined);
      expect(status).toBe('error');
      expect(typeof reason).toBe('string');
    });

    it('handles POJO without message/status/code', () => {
      const { status, reason } = classifyError({ foo: 'bar' });
      expect(status).toBe('error');
      expect(typeof reason).toBe('string');
    });
  });
});
