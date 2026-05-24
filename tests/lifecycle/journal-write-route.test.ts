// tests/lifecycle/journal-write-route.test.ts
import { WRITE_ROUTES } from '../../packages/core/src/lifecycle/stage-io.js';
it('journal-record is a write route', () => {
  expect((WRITE_ROUTES as readonly string[]).includes('journal-record')).toBe(true);
});
