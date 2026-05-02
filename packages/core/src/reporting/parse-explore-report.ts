export interface ExploreThread {
  index: number;
  title: string;
  summary: string;
  internalAnchors: string[];
  externalSources: string[];
  divergenceAxis: string;
}

export type ExploreDropReason =
  | 'invalid_header'
  | 'invalid_index'
  | 'empty_title'
  | 'duplicate_index'
  | 'missing_field'
  | 'out_of_order_field'
  | 'duplicate_field'
  | 'empty_summary'
  | 'empty_internal_anchors'
  | 'empty_external_sources'
  | 'empty_divergence_axis';

export interface DroppedExploreThread {
  header: string;
  reason: ExploreDropReason;
  detail: string;
}

export interface ParsedExploreReport {
  threads: ExploreThread[];
  recommendedNextStep: string | null;
  diagnostics: {
    /**
     * True when structured explore content was present but no valid thread could
     * be parsed. Partial reports with at least one valid thread report dropped
     * malformed sections through droppedThreadDiagnostics instead.
     */
    malformed: boolean;
    insufficientThreads: boolean;
    /** Back-compatible list of raw thread headers that were dropped. */
    droppedThreads: string[];
    droppedThreadDiagnostics: DroppedExploreThread[];
  };
}

export type ExploreParseResult =
  | { kind: 'no_structured_report' }
  | { kind: 'structured_report'; report: ParsedExploreReport };

type FieldName = 'internalAnchors' | 'externalSources' | 'divergenceAxis';

interface FieldMatch {
  name: FieldName;
  label: string;
  index: number;
  contentStart: number;
}

interface ThreadBodyParseSuccess {
  ok: true;
  summary: string;
  internalAnchors: string[];
  externalSources: string[];
  divergenceAxis: string;
}

interface ThreadBodyParseFailure {
  ok: false;
  reason: ExploreDropReason;
  detail: string;
}

type ThreadBodyParseResult = ThreadBodyParseSuccess | ThreadBodyParseFailure;

const FIELD_LABEL_RE = /^\*\*(Internal anchors:|External sources:|Divergence axis:)\*\*[ \t]*/gim;
const EXPECTED_FIELD_ORDER: FieldName[] = ['internalAnchors', 'externalSources', 'divergenceAxis'];

function fieldNameForLabel(label: string): FieldName {
  const normalized = label.toLowerCase();
  if (normalized === 'internal anchors:') return 'internalAnchors';
  if (normalized === 'external sources:') return 'externalSources';
  return 'divergenceAxis';
}

function parseBullets(raw: string): string[] {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^[-*]\s+/.test(l))
    .map(l => l.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

function collectFieldMatches(body: string): FieldMatch[] {
  const matches: FieldMatch[] = [];
  FIELD_LABEL_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FIELD_LABEL_RE.exec(body)) !== null) {
    matches.push({
      name: fieldNameForLabel(match[1]),
      label: match[1],
      index: match.index,
      contentStart: FIELD_LABEL_RE.lastIndex,
    });
  }

  return matches;
}

function invalidFieldOrder(fields: FieldMatch[]): ThreadBodyParseFailure | null {
  const seen = new Set<FieldName>();
  for (const field of fields) {
    if (seen.has(field.name)) {
      return {
        ok: false,
        reason: 'duplicate_field',
        detail: `duplicate field label: ${field.label}`,
      };
    }
    seen.add(field.name);
  }

  const fieldOrder = fields.map(f => f.name);
  for (let i = 0; i < EXPECTED_FIELD_ORDER.length; i++) {
    if (fieldOrder[i] !== EXPECTED_FIELD_ORDER[i]) {
      const missing = EXPECTED_FIELD_ORDER.filter(name => !seen.has(name));
      if (missing.length > 0) {
        return {
          ok: false,
          reason: 'missing_field',
          detail: `missing required field(s): ${missing.join(', ')}`,
        };
      }
      return {
        ok: false,
        reason: 'out_of_order_field',
        detail: 'fields must appear in order: summary, Internal anchors, External sources, Divergence axis',
      };
    }
  }

  return null;
}

function parseThreadBody(body: string): ThreadBodyParseResult {
  const fields = collectFieldMatches(body);
  const orderFailure = invalidFieldOrder(fields);
  if (orderFailure) return orderFailure;

  const internalField = fields[0];
  const externalField = fields[1];
  const divergenceField = fields[2];

  const summary = body.slice(0, internalField.index).trim();
  if (!summary) {
    return { ok: false, reason: 'empty_summary', detail: 'summary before Internal anchors is empty' };
  }

  const internalAnchors = parseBullets(body.slice(internalField.contentStart, externalField.index));
  if (internalAnchors.length === 0) {
    return { ok: false, reason: 'empty_internal_anchors', detail: 'Internal anchors has no bullet entries' };
  }

  const externalSources = parseBullets(body.slice(externalField.contentStart, divergenceField.index));
  if (externalSources.length === 0) {
    return { ok: false, reason: 'empty_external_sources', detail: 'External sources has no bullet entries' };
  }

  const divergenceAxis = body.slice(divergenceField.contentStart).trim();
  if (!divergenceAxis) {
    return { ok: false, reason: 'empty_divergence_axis', detail: 'Divergence axis is empty' };
  }

  return { ok: true, summary, internalAnchors, externalSources, divergenceAxis };
}

function splitIntoSections(raw: string): Array<{ header: string; body: string }> {
  const sections: Array<{ header: string; body: string }> = [];
  const parts = raw.split(/(?=^##\s)/m);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith('## ')) continue;
    const newlineIdx = trimmed.indexOf('\n');
    const header = trimmed.slice(3, newlineIdx === -1 ? undefined : newlineIdx).trim();
    const body = newlineIdx === -1 ? '' : trimmed.slice(newlineIdx + 1).trim();
    sections.push({ header, body });
  }
  return sections;
}

function buildReport(
  threads: ExploreThread[],
  recommendedNextStep: string | null,
  droppedThreadDiagnostics: DroppedExploreThread[],
): ExploreParseResult {
  return {
    kind: 'structured_report',
    report: {
      threads,
      recommendedNextStep,
      diagnostics: {
        malformed: threads.length === 0,
        insufficientThreads: threads.length < 3,
        droppedThreads: droppedThreadDiagnostics.map(d => d.header),
        droppedThreadDiagnostics,
      },
    },
  };
}

export function parseExploreReport(rawOutput: string): ExploreParseResult {
  if (typeof rawOutput !== 'string' || !rawOutput.trim()) return { kind: 'no_structured_report' };

  const sections = splitIntoSections(rawOutput);

  const threadSections: Array<{ header: string; body: string }> = [];
  let recommendedNextStep: string | null = null;
  let hasRecommendedNextStep = false;

  for (const section of sections) {
    if (/^Thread\s+\S/.test(section.header)) {
      threadSections.push(section);
    } else if (/^Recommended next step$/i.test(section.header)) {
      hasRecommendedNextStep = true;
      recommendedNextStep = section.body || null;
    }
  }

  if (threadSections.length === 0) {
    if (hasRecommendedNextStep) {
      return buildReport([], recommendedNextStep, []);
    }
    return { kind: 'no_structured_report' };
  }

  const threads: ExploreThread[] = [];
  const droppedThreadDiagnostics: DroppedExploreThread[] = [];
  const seenIndexes = new Set<number>();

  const drop = (header: string, reason: ExploreDropReason, detail: string) => {
    droppedThreadDiagnostics.push({ header, reason, detail });
  };

  for (const section of threadSections) {
    const headerMatch = section.header.match(/^Thread\s+([^:]+):\s*(.*)$/);
    if (!headerMatch) {
      drop(section.header, 'invalid_header', 'thread header must match "Thread <positive integer>: <title>"');
      continue;
    }

    const index = Number(headerMatch[1]);
    const title = headerMatch[2].trim();

    if (!Number.isSafeInteger(index) || index < 1) {
      drop(section.header, 'invalid_index', 'thread index must be a positive safe integer');
      continue;
    }

    if (!title) {
      drop(section.header, 'empty_title', 'thread title is empty');
      continue;
    }

    if (seenIndexes.has(index)) {
      drop(section.header, 'duplicate_index', `thread index ${index} was already parsed`);
      continue;
    }

    const parsed = parseThreadBody(section.body);
    if (!parsed.ok) {
      drop(section.header, parsed.reason, parsed.detail);
      continue;
    }

    seenIndexes.add(index);
    threads.push({
      index,
      title,
      summary: parsed.summary,
      internalAnchors: parsed.internalAnchors,
      externalSources: parsed.externalSources,
      divergenceAxis: parsed.divergenceAxis,
    });
  }

  return buildReport(threads, recommendedNextStep, droppedThreadDiagnostics);
}
