import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8').toLowerCase();
const software = (route: string) => read(`packages/core/src/skills/${route}/implement-software.md`);

describe('software practice behavioural regression', () => {
  it('retains the proven technique for every explicitly routed type', () => {
    for (const route of ['plan', 'execute_plan', 'review']) {
      const prompt = software(route);
      for (const marker of ['caller', 'error', 'security', 'schema', 'test']) expect(prompt).toContain(marker);
    }
    const debug = software('debug');
    for (const marker of ['stack trace', 'bisection', 'test isolation', 'reproduce']) expect(debug).toContain(marker);
    expect(read('packages/core/src/skills/plan/implement.md')).not.toContain('security sinks');
  });
});