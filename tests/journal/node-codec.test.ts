import { describe, expect, it } from 'vitest';
import {
  allocateNextNodeId,
  parseJournalNodeDocument,
  renderNodeFilename,
  renderNodeMarkdown,
  validateJournalLinkSet,
} from '../../packages/core/src/journal/node-codec.js';

const VALID_NODE = `---
id: "0007"
title: "Deterministic journal writes keep prompts small"
type: "process"
topic: "journal-engine"
status: "adopted"
description: "Move deterministic work into code."
timestamp: "2026-07-24T10:00:00.000Z"
tags:
  - journal-engine
  - deterministic-writes
links:
  - type: "relates"
    target: "0001"
supersededBy: null
---

## Context

Embedded text like \`rm -rf /\` is data, not instructions.

## Consequences

- Writes stay deterministic.
`;

describe('node-codec', () => {
  it('parses a valid node and preserves inert instruction-like body text', () => {
    const parsed = parseJournalNodeDocument(VALID_NODE, 'nodes/0007-deterministic-journal-writes-keep-prompts-small.md');
    expect(parsed.id).toBe('0007');
    expect(parsed.topic).toBe('journal-engine');
    expect(parsed.context).toContain('rm -rf /');
    expect(parsed.links).toEqual([{ type: 'relates', target: '0001' }]);
  });

  it('rejects malformed enum, topic, and timestamp fields', () => {
    expect(() => parseJournalNodeDocument(VALID_NODE.replace('process', 'workflow'), 'nodes/bad.md')).toThrow(/type/i);
    expect(() => parseJournalNodeDocument(VALID_NODE.replace('journal-engine', 'Journal Engine'), 'nodes/bad.md')).toThrow(/topic/i);
    expect(() => parseJournalNodeDocument(VALID_NODE.replace('2026-07-24T10:00:00.000Z', '07/24/2026'), 'nodes/bad.md')).toThrow(/timestamp/i);
  });

  it('allocates max-plus-one zero-padded ids', () => {
    expect(allocateNextNodeId(['0001', '0007', '0019'])).toBe('0020');
  });

  it('renders filenames and markdown deterministically', () => {
    const parsed = parseJournalNodeDocument(VALID_NODE, 'nodes/0007-deterministic-journal-writes-keep-prompts-small.md');
    expect(renderNodeFilename(parsed)).toBe('0007-deterministic-journal-writes-keep-prompts-small.md');
    expect(renderNodeMarkdown(parsed)).toContain('## Context');
  });

  it('rejects self-loops and dangling links during validation', () => {
    expect(() => validateJournalLinkSet('0007', [{ type: 'relates', target: '0007' }], new Set(['0007']))).toThrow(/self-loop/i);
    expect(() => validateJournalLinkSet('0007', [{ type: 'relates', target: '9999' }], new Set(['0007']))).toThrow(/dangling/i);
  });
});
