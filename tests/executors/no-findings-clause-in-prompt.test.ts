import { describe, it, expect } from 'vitest';
import { compileAuditDocument } from '../../packages/core/src/intake/compilers/audit.js';
import { compileInvestigate } from '../../packages/core/src/intake/compilers/investigate.js';

const FORBIDDEN = [
  /findings\[\]/i,
  /fenced code block/i,
  /```json/,
];

describe('read-only intake compilers do NOT request structured findings', () => {
  it('audit compiler omits findings[] / json contract', () => {
    const tasks = compileAuditDocument({ auditType: 'correctness', filePaths: ['/tmp/x.md'] }, 'req-1');
    for (const task of tasks) {
      for (const pat of FORBIDDEN) {
        expect(task.prompt).not.toMatch(pat);
      }
    }
  });

  it('investigate compiler omits findings[] / json contract', () => {
    const task = compileInvestigate(
      { question: 'what does foo do?', filePaths: [] } as never,
      [],
      [],
      [],
      '/tmp',
    );
    for (const pat of FORBIDDEN) {
      expect(task.prompt).not.toMatch(pat);
    }
  });
});
