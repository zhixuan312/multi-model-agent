import { describe, it, expect } from 'vitest';
import { StructuredReportParser } from '../../packages/core/src/reporting/structured-report-parser.js';

describe('StructuredReportParser framework', () => {
  it('delegates to schema.parse', () => {
    const p = new StructuredReportParser<{ x: number }>({ parse: (t) => ({ x: parseInt(t, 10) }) });
    expect(p.parse('42')).toEqual({ x: 42 });
  });
});
