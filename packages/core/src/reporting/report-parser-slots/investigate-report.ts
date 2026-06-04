import type { ReportSchema } from '../structured-report-parser.js';
import { parseStructuredReport } from '../structured-report.js';

// ── Citation parsing ──

export interface Citation {
  file: string;
  lines: string;
  claim: string;
}

export interface ParseCitationsResult {
  citations: Citation[];
  malformedCitationLines: number;
}

const LINE_TOKEN_RE = /^(?:[1-9][0-9]*)(?:-[1-9][0-9]*)?$/;
const CITATION_RE = /^(?<file>.+):(?<lines>\d+(?:-\d+)?)\s+(?:—|--)\s+(?<claim>.+)$/;
const BULLET_RE = /^(?:[-*]|\d+[.)])\s+/;

function isValidLineToken(token: string): boolean {
  if (!LINE_TOKEN_RE.test(token)) return false;
  const parts = token.split('-');
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isSafeInteger(n)) return false;
  }
  if (parts.length === 2) {
    const [start, end] = parts.map(Number);
    if (start! > end!) return false;
  }
  return true;
}

/**
 * Strip leading/trailing backticks from a `file:line` token.
 *
 * Workers commonly wrap the file:line portion in backticks for visual
 * styling (e.g. `` `src/foo.ts:42` ``). The CITATION_RE matches the raw
 * pattern, so strip the backticks before matching. Without this, every
 * backtick-wrapped citation would be flagged as malformed even though
 * the content is correct.
 */
function stripBacktickWrap(s: string): string {
  // Strip a leading backtick if it exists, and a trailing backtick at the
  // end of the file:line portion (just before the em-dash separator). We
  // do this conservatively: only strip when both ends actually have a
  // backtick at expected positions, to avoid mangling claims that
  // legitimately contain backticks (e.g. `` `auditType` is a parameter ``).
  let out = s;
  // Leading backtick: `path:line` ...
  if (out.startsWith('`')) {
    const closeIdx = out.indexOf('`', 1);
    // Only strip if the closing backtick comes BEFORE the em-dash separator
    // (i.e. it wraps just the path:line portion, not the whole line).
    const sepIdx = out.search(/\s+(?:—|--)\s+/);
    if (closeIdx !== -1 && (sepIdx === -1 || closeIdx < sepIdx)) {
      out = out.slice(1, closeIdx) + out.slice(closeIdx + 1);
    }
  }
  return out;
}

export function parseCitations(rawLines: string[]): ParseCitationsResult {
  const citations: Citation[] = [];
  let malformed = 0;
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const stripped = stripBacktickWrap(trimmed.replace(BULLET_RE, ''));
    const match = stripped.match(CITATION_RE);
    if (!match || !match.groups) {
      malformed++;
      continue;
    }
    const { file, lines, claim } = match.groups;
    if (!isValidLineToken(lines!)) {
      malformed++;
      continue;
    }
    if (!claim || !claim.trim()) {
      malformed++;
      continue;
    }
    citations.push({ file: file!.trim(), lines: lines!, claim: claim.trim() });
  }
  return { citations, malformedCitationLines: malformed };
}

// ── Confidence parsing ──

export interface Confidence {
  level: 'high' | 'medium' | 'low';
  rationale: string;
}

const CONFIDENCE_HEAD_RE = /^(high|medium|low)(?:(?:\s+(?:—|--)\s+|:\s*)(.*))?\s*$/i;

export function parseConfidence(rawLines: string[]): Confidence | null {
  const firstIdx = rawLines.findIndex(l => l.trim());
  if (firstIdx === -1) return null;
  // Strip a leading wrapping backtick if the worker styled the level
  // (e.g. "`high` — rationale"). This mirrors stripBacktickWrap in the
  // citation parser; without it, a backtick-styled level token is
  // flagged as malformed even though the content is correct.
  let head = rawLines[firstIdx]!.trim();
  if (head.startsWith('`')) {
    const closeIdx = head.indexOf('`', 1);
    const sepIdx = head.search(/\s+(?:—|--)\s+/);
    if (closeIdx !== -1 && (sepIdx === -1 || closeIdx < sepIdx)) {
      head = head.slice(1, closeIdx) + head.slice(closeIdx + 1);
    }
  }
  const m = head.match(CONFIDENCE_HEAD_RE);
  if (!m) return null;
  const level = m[1]!.toLowerCase() as 'high' | 'medium' | 'low';
  const headRationale = m[2]?.trim() ?? '';
  const rest = rawLines
    .slice(firstIdx + 1)
    .map(l => l.trim())
    .filter(Boolean);
  const rationale = [headRationale, ...rest].filter(Boolean).join('\n');
  return { level, rationale };
}

// ── Finding parsing ──

export interface Finding {
  title: string;
  evidence: Citation[];
  evidenceIsNone: boolean;
}

// ── Investigation report parsing ──

export interface ParsedInvestigation {
  citations: Citation[];
  findings: Finding[];
  confidence: Confidence | null;
  needsCallerClarification: boolean;
  diagnostics: {
    malformedCitationLines: number;
    missingRequiredSections: string[];
    invalidRequiredSections: string[];
  };
}

export interface SectionValidity {
  summary: 'valid' | 'empty' | 'missing';
  citations: 'valid' | 'empty_legitimate' | 'empty_invalid' | 'missing';
  confidence: 'valid' | 'invalid' | 'missing';
}

export type InvestigationParseResult =
  | { kind: 'no_structured_report' }
  | { kind: 'structured_report'; investigation: ParsedInvestigation; sectionValidity: SectionValidity };

function isLegitimatelyNone(lines: string[]): boolean {
  const stripped = lines.map(l => l.trim().replace(/^[-*]\s+/, '').toLowerCase()).filter(Boolean);
  return stripped.length === 1 && (stripped[0] === '(none)' || stripped[0] === 'none');
}

function hasSectionHeader(raw: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:##|#)\\s*${escaped}\\b`, 'mi').test(raw);
}

const NEEDS_CONTEXT_BULLET_RE = /^(?:[-*]|\d+[.)])\s+\[needs_context\]/i;

function detectNeedsContext(unresolvedLines: string[]): boolean {
  return unresolvedLines.some(l => NEEDS_CONTEXT_BULLET_RE.test(l.trim()));
}

// ── Finding block parsing ──

const FINDING_BLOCK_RE = /^##\s+finding\s+\d+:\s*(.+)$/im;
const EVIDENCE_BULLET_RE = /^(?:[-*]|\d+[.)])\s+evidence:\s*(.+)$/im;

function parseEvidenceLine(line: string): { isNone: boolean; citations: Citation[]; malformed: number } {
  const match = line.match(EVIDENCE_BULLET_RE);
  if (!match || !match[1]) {
    return { isNone: false, citations: [], malformed: 0 };
  }
  const evidenceContent = match[1]!.trim();

  // Check if evidence is (none)
  if (evidenceContent === '(none)' || evidenceContent === 'none') {
    return { isNone: true, citations: [], malformed: 0 };
  }

  // Parse as a citation line (format: file:lines — claim or file:lines -- claim)
  const citationMatch = evidenceContent.match(CITATION_RE);
  if (!citationMatch || !citationMatch.groups) {
    return { isNone: false, citations: [], malformed: 1 };
  }

  const { file, lines, claim } = citationMatch.groups;
  if (!isValidLineToken(lines!)) {
    return { isNone: false, citations: [], malformed: 1 };
  }
  if (!claim || !claim.trim()) {
    return { isNone: false, citations: [], malformed: 1 };
  }

  return {
    isNone: false,
    citations: [{ file: file!.trim(), lines: lines!, claim: claim.trim() }],
    malformed: 0,
  };
}

function extractFindingsFromReport(rawOutput: string): {
  findings: Finding[];
  allCitations: Citation[];
  malformedEvidenceLines: number;
} {
  const findings: Finding[] = [];
  let allCitations: Citation[] = [];
  let malformedCount = 0;

  // Split by Finding blocks (case-insensitive)
  const findingRegex = /^##\s+finding\s+\d+:\s*(.+)$/im;
  const lines = rawOutput.split('\n');
  let currentFinding: { title: string; lines: string[] } | null = null;

  for (const line of lines) {
    const findingMatch = line.match(findingRegex);
    if (findingMatch) {
      // Start a new finding
      if (currentFinding) {
        // Process the previous finding
        const finding = processFindingLines(currentFinding);
        if (finding) {
          findings.push(finding);
          allCitations = allCitations.concat(finding.evidence);
          malformedCount += finding.malformedLines;
        }
      }
      currentFinding = { title: findingMatch[1]!.trim(), lines: [] };
    } else if (currentFinding) {
      currentFinding.lines.push(line);
    }
  }

  // Process the last finding
  if (currentFinding) {
    const finding = processFindingLines(currentFinding);
    if (finding) {
      findings.push(finding);
      allCitations = allCitations.concat(finding.evidence);
      malformedCount += finding.malformedLines;
    }
  }

  return { findings, allCitations, malformedEvidenceLines: malformedCount };
}

interface ProcessedFinding extends Finding {
  malformedLines: number;
}

function processFindingLines(finding: { title: string; lines: string[] }): ProcessedFinding | null {
  let evidenceIsNone = false;
  let citations: Citation[] = [];
  let malformed = 0;

  // Look for Evidence: bullet
  for (const line of finding.lines) {
    if (EVIDENCE_BULLET_RE.test(line)) {
      const result = parseEvidenceLine(line);
      evidenceIsNone = result.isNone;
      citations = result.citations;
      malformed = result.malformed;
      break;
    }
  }

  return {
    title: finding.title,
    evidence: citations,
    evidenceIsNone,
    malformedLines: malformed,
  };
}

export function parseInvestigationReport(rawOutput: string): InvestigationParseResult {
  if (!rawOutput || !rawOutput.trim()) return { kind: 'no_structured_report' };

  // Check for investigation headers: can have Findings, or traditional Citations/Confidence/Summary
  const hasFindingsHeader = hasSectionHeader(rawOutput, 'finding');
  const recognized = ['summary', 'citations', 'confidence'];
  const hasTraditionalHeader = recognized.some(name => hasSectionHeader(rawOutput, name));
  if (!hasFindingsHeader && !hasTraditionalHeader) return { kind: 'no_structured_report' };

  const generic = parseStructuredReport(rawOutput);

  const summaryHeaderPresent = hasSectionHeader(rawOutput, 'summary');
  let summaryValidity: SectionValidity['summary'];
  if (!summaryHeaderPresent) summaryValidity = 'missing';
  else if (generic.summary && generic.summary.trim()) summaryValidity = 'valid';
  else summaryValidity = 'empty';

  const confidenceHeaderPresent = hasSectionHeader(rawOutput, 'confidence');
  const confidenceLines = generic.extraSections['confidence'] ?? [];
  const confidenceParsed = parseConfidence(confidenceLines);
  let confidenceValidity: SectionValidity['confidence'];
  if (!confidenceHeaderPresent) confidenceValidity = 'missing';
  else if (confidenceParsed) confidenceValidity = 'valid';
  else confidenceValidity = 'invalid';

  // Extract findings and citations from Finding blocks if present
  const { findings: rawFindings, allCitations: findingsCitations, malformedEvidenceLines } = extractFindingsFromReport(rawOutput);

  // Second-pass: filter findings with evidenceIsNone when confidence is not low
  let finalFindings = rawFindings;
  if (confidenceParsed && confidenceParsed.level !== 'low') {
    finalFindings = rawFindings.filter(f => !f.evidenceIsNone);
  }

  // Determine citations validity
  let citationsValidity: SectionValidity['citations'];
  let citationsParsed: { citations: Citation[]; malformedCitationLines: number };

  if (hasFindingsHeader && rawFindings.length > 0) {
    // Use citations from findings
    citationsParsed = { citations: findingsCitations, malformedCitationLines: malformedEvidenceLines };
    citationsValidity = findingsCitations.length > 0 ? 'valid' : 'empty_invalid';
  } else {
    // Fall back to traditional ## Citations section
    const citationsHeaderPresent = hasSectionHeader(rawOutput, 'citations');
    const citationsLines = generic.extraSections['citations'] ?? [];
    if (!citationsHeaderPresent) {
      citationsValidity = 'missing';
      citationsParsed = { citations: [], malformedCitationLines: 0 };
    } else if (isLegitimatelyNone(citationsLines)) {
      citationsParsed = { citations: [], malformedCitationLines: 0 };
      citationsValidity = (confidenceParsed?.level === 'low') ? 'empty_legitimate' : 'empty_invalid';
    } else {
      citationsParsed = parseCitations(citationsLines);
      citationsValidity = citationsParsed.citations.length > 0 ? 'valid' : 'empty_invalid';
    }
  }

  const missing: string[] = [];
  const invalid: string[] = [];
  if (summaryValidity === 'missing') missing.push('summary');
  else if (summaryValidity === 'empty') invalid.push('summary');
  if (citationsValidity === 'missing') missing.push('citations');
  else if (citationsValidity === 'empty_invalid') invalid.push('citations');
  if (confidenceValidity === 'missing') missing.push('confidence');
  else if (confidenceValidity === 'invalid') invalid.push('confidence');

  const unresolvedLines = generic.unresolved;
  const needsCallerClarification = detectNeedsContext(unresolvedLines);

  return {
    kind: 'structured_report',
    investigation: {
      citations: citationsParsed.citations,
      findings: finalFindings,
      confidence: confidenceParsed,
      needsCallerClarification,
      diagnostics: {
        malformedCitationLines: citationsParsed.malformedCitationLines,
        missingRequiredSections: missing,
        invalidRequiredSections: invalid,
      },
    },
    sectionValidity: { summary: summaryValidity, citations: citationsValidity, confidence: confidenceValidity },
  };
}

// ── ReportSchema adapter ──

export interface InvestigateReportOutput {
  kind: 'structured_report';
  investigation: ParsedInvestigation;
  sectionValidity: SectionValidity;
}

export const investigateReportSchema: ReportSchema<InvestigateReportOutput> = {
  parse(text: string): InvestigateReportOutput {
    const result = parseInvestigationReport(text);
    if (result.kind !== 'structured_report') {
      throw new Error('investigate output has no structured report');
    }
    return result;
  },
};
