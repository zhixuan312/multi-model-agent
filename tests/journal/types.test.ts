import { EDGE_TYPES, STATUS_VALUES, isEdgeType, isStatus } from '../../packages/core/src/journal/types.js';
import { DEFAULT_SCHEMA_MD } from '../../packages/core/src/journal/default-schema.js';

describe('journal types', () => {
  it('enumerates the six edge types and four statuses', () => {
    expect(EDGE_TYPES).toEqual(['supersedes','refines','relates','depends-on','contradicts','parent']);
    expect(STATUS_VALUES).toEqual(['adopted','dropped','inconclusive','superseded']);
  });
  it('guards reject unknown values', () => {
    expect(isEdgeType('refines')).toBe(true);
    expect(isEdgeType('mentions')).toBe(false);
    expect(isStatus('adopted')).toBe(true);
    expect(isStatus('archived')).toBe(false);
  });
  it('default schema names the conventions', () => {
    expect(DEFAULT_SCHEMA_MD).toMatch(/supersedes/);
    expect(DEFAULT_SCHEMA_MD).toMatch(/zero-padded/i);
  });
});
