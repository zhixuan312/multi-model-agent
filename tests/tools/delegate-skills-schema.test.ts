import { inputSchema } from '../../packages/core/src/tools/delegate/schema.js';
import { delegateBriefSlot } from '../../packages/core/src/tools/delegate/brief-slot.js';

describe('delegate skills contract', () => {
  it('accepts an optional skills array per task', () => {
    const parsed = inputSchema.parse({
      tasks: [{ prompt: 'do x', skills: ['atlassian-fetch'] }],
    });
    expect(parsed.tasks[0].skills).toEqual(['atlassian-fetch']);
  });

  it('omits skills when not provided', () => {
    const parsed = inputSchema.parse({ tasks: [{ prompt: 'do x' }] });
    expect(parsed.tasks[0].skills).toBeUndefined();
  });

  it('rejects empty skill names', () => {
    expect(() => inputSchema.parse({ tasks: [{ prompt: 'x', skills: [''] }] })).toThrow();
  });

  it('briefSlot carries skills onto the brief', () => {
    const briefs = delegateBriefSlot(
      inputSchema.parse({ tasks: [{ prompt: 'do x', skills: ['a', 'b'] }] }),
    );
    expect(briefs[0].skills).toEqual(['a', 'b']);
  });
});
