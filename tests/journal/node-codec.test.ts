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

  it('rejects malformed enum and timestamp fields', () => {
    expect(() => parseJournalNodeDocument(VALID_NODE.replace('process', 'workflow'), 'nodes/bad.md')).toThrow(/type/i);
    expect(() => parseJournalNodeDocument(VALID_NODE.replace('2026-07-24T10:00:00.000Z', '07/24/2026'), 'nodes/bad.md')).toThrow(/timestamp/i);
  });

  it('salvages a non-slug topic instead of dropping the node', () => {
    // A liberal reader: "Lunch Vote" (space + capitals) becomes the slug so recall
    // still returns the node, rather than the caller silently skipping it (data loss).
    const parsed = parseJournalNodeDocument(
      VALID_NODE.replace('journal-engine', 'Lunch Vote'),
      'nodes/0007-x.md',
    );
    expect(parsed.topic).toBe('lunch-vote');
  });

  it('recovers a numeric YAML-parsed id from the filename prefix', () => {
    // Unquoted `id: 0012` YAML-parses to a number; the filename prefix is authoritative.
    const numericId = VALID_NODE.replace('id: "0007"', 'id: 0012');
    const parsed = parseJournalNodeDocument(numericId, 'nodes/0012-inline-style-palette.md');
    expect(parsed.id).toBe('0012');
  });

  it('allocates max-plus-one zero-padded ids', () => {
    expect(allocateNextNodeId(['0001', '0007', '0019'])).toBe('0020');
  });

  it('renders filenames and markdown deterministically', () => {
    const parsed = parseJournalNodeDocument(VALID_NODE, 'nodes/0007-deterministic-journal-writes-keep-prompts-small.md');
    expect(renderNodeFilename(parsed)).toBe('0007-deterministic-journal-writes-keep-prompts-small.md');
    expect(renderNodeMarkdown(parsed)).toContain('## Context');
  });

  it('accepts a legacy `to` link field as an alias for `target`', () => {
    const legacy = VALID_NODE.replace('    target: "0001"', '    to: "0001"');
    const parsed = parseJournalNodeDocument(legacy, 'nodes/0007-legacy-to.md');
    expect(parsed.links).toEqual([{ type: 'relates', target: '0001' }]);
  });

  it('accepts a timezone-offset timestamp, not just Z', () => {
    const offset = VALID_NODE.replace('2026-07-24T10:00:00.000Z', '2026-07-18T18:48:29+08:00');
    const parsed = parseJournalNodeDocument(offset, 'nodes/0007-offset-ts.md');
    expect(parsed.timestamp).toBe('2026-07-18T18:48:29+08:00');
  });

  it('rejects self-loops and dangling links during validation', () => {
    expect(() => validateJournalLinkSet('0007', [{ type: 'relates', target: '0007' }], new Set(['0007']))).toThrow(/self-loop/i);
    expect(() => validateJournalLinkSet('0007', [{ type: 'relates', target: '9999' }], new Set(['0007']))).toThrow(/dangling/i);
  });
});
