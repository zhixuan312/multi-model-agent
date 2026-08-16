import matter from 'gray-matter';

export type JournalNodeType = 'decision' | 'design' | 'behavior' | 'process' | 'knowledge' | 'style';
export type JournalNodeStatus = 'adopted' | 'dropped' | 'inconclusive' | 'superseded';
export type JournalLinkType = 'supersedes' | 'refines' | 'relates' | 'depends-on' | 'contradicts' | 'parent';

export interface JournalLink {
  type: JournalLinkType;
  target: string;
}

export interface JournalNodeDocument {
  id: string;
  title: string;
  type: JournalNodeType;
  topic: string;
  status: JournalNodeStatus;
  description: string;
  timestamp: string;
  tags: string[];
  links: JournalLink[];
  supersededBy: string | null;
  context: string;
  consequences: string;
  sourcePath: string;
}

// FOUR OR MORE digits, zero-padded to at least four.
//
// This was `/^\d{4}$/`, a hard ceiling at 10,000 nodes that failed by CORRUPTION rather than by
// error: `allocateNextNodeId` returned `"10000"` past 9999, this regex rejected it, and
// `coerceNodeId` fell through to the filename — where `([0-9]{4})-` matched the last four digits
// of `10000-slug.md` and produced `"0000"`, the id of the very first node. The collision then
// repeated forever, because `allocateNextNodeId` re-derived its maximum from a set that no longer
// contained 10000. Links resolved to the wrong node and the index keyed two nodes to one row.
//
// Widening is backward-compatible: every id ever written is four digits and still matches.
const ID_RE = /^\d{4,}$/;
// Accept a trailing `Z` (UTC) OR a `±HH:MM` timezone offset. Legacy nodes were
// written with offset timestamps (e.g. `2026-07-18T18:48:29+08:00`); the renderer
// still writes the canonical `Z` form.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const TYPES = new Set<JournalNodeType>(['decision', 'design', 'behavior', 'process', 'knowledge', 'style']);
const STATUSES = new Set<JournalNodeStatus>(['adopted', 'dropped', 'inconclusive', 'superseded']);
const LINK_TYPES = new Set<JournalLinkType>(['supersedes', 'refines', 'relates', 'depends-on', 'contradicts', 'parent']);

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Invalid ${field}`);
  return value;
}

// The topic is a lowercase-dash slug (the recall/index key). Be a LIBERAL reader:
// coerce any non-slug frontmatter value to its slug rather than rejecting the whole
// node. A stricter reader here just makes the caller silently skip the node (data
// loss), and the write path historically persisted whatever topic it was handed.
// Slugifying on read recovers such nodes and self-heals them on the next write batch
// (which re-renders every loaded node). Idempotent on already-valid slugs.
export function slugifyTopic(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'unscoped';
}

// Resolve a node's canonical id (four digits, or more once the corpus passes 9,999). A quoted frontmatter id is authoritative;
// otherwise fall back to the filename prefix (renderNodeFilename writes `<id>-<slug>.md`,
// so the leading 4 digits ARE the id) — this recovers nodes whose unquoted `id: 0012`
// YAML-parsed to a number (octal/int) and would otherwise throw. Numeric coercion is a
// last resort only when the path carries no prefix.
function coerceNodeId(rawId: unknown, sourcePath: string): string {
  if (typeof rawId === 'string' && ID_RE.test(rawId.trim())) return rawId.trim();
  const fromFilename = sourcePath.match(/(?:^|\/)([0-9]{4,})-[^/]*$/)?.[1];
  if (fromFilename) return fromFilename;
  if (typeof rawId === 'number' && Number.isInteger(rawId) && rawId >= 0) {
    return String(rawId).padStart(4, '0');
  }
  throw new Error('Invalid id');
}

function parseBodySection(body: string, heading: 'Context' | 'Consequences'): string {
  const match = body.match(new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match?.[1]?.trim() ?? '';
}

export function validateJournalLinkSet(nodeId: string, links: JournalLink[], knownIds: Set<string>): void {
  for (const link of links) {
    if (!LINK_TYPES.has(link.type)) throw new Error(`Invalid link type: ${link.type}`);
    if (link.target === nodeId) throw new Error(`Invalid self-loop for ${nodeId}`);
    if (!knownIds.has(link.target)) throw new Error(`Invalid dangling edge target: ${link.target}`);
  }
}

export function allocateNextNodeId(existingIds: string[]): string {
  const max = existingIds.reduce((current, id) => Math.max(current, Number.parseInt(id, 10)), 0);
  return String(max + 1).padStart(4, '0');
}

export function renderNodeFilename(node: Pick<JournalNodeDocument, 'id' | 'title'>): string {
  const slug = node.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${node.id}-${slug}.md`;
}

export function parseJournalNodeDocument(raw: string, sourcePath: string): JournalNodeDocument {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const id = coerceNodeId(data.id, sourcePath);
  const title = asString(data.title, 'title');
  const type = asString(data.type, 'type') as JournalNodeType;
  const topic = slugifyTopic(asString(data.topic, 'topic'));
  const status = asString(data.status, 'status') as JournalNodeStatus;
  const description = asString(data.description, 'description');
  const timestamp = asString(data.timestamp, 'timestamp');
  const tags = Array.isArray(data.tags) ? data.tags.map((tag) => asString(tag, 'tag')) : [];
  const links = Array.isArray(data.links)
    ? data.links.map((entry) => {
      const link = entry as Record<string, unknown>;
      // Legacy nodes spelled the destination field `to`; canonical is `target`.
      // Accept either on read (the renderer always writes `target`).
      return {
        type: asString(link.type, 'link.type') as JournalLinkType,
        target: asString(link.target ?? link.to, 'link.target'),
      };
    })
    : [];
  const supersededBy = data.supersededBy === null || data.supersededBy === undefined ? null : asString(data.supersededBy, 'supersededBy');

  if (!TYPES.has(type)) throw new Error('Invalid type');
  if (!STATUSES.has(status)) throw new Error('Invalid status');
  if (!ISO_RE.test(timestamp)) throw new Error('Invalid timestamp');
  if (status === 'superseded' && !supersededBy) throw new Error('Superseded nodes require supersededBy');

  return {
    id,
    title,
    type,
    topic,
    status,
    description,
    timestamp,
    tags,
    links,
    supersededBy,
    context: parseBodySection(parsed.content, 'Context'),
    consequences: parseBodySection(parsed.content, 'Consequences'),
    sourcePath,
  };
}

export function renderNodeMarkdown(node: JournalNodeDocument): string {
  const frontmatter = [
    '---',
    `id: "${node.id}"`,
    `title: "${node.title}"`,
    `type: "${node.type}"`,
    `topic: "${node.topic}"`,
    `status: "${node.status}"`,
    `description: "${node.description}"`,
    `timestamp: "${node.timestamp}"`,
    'tags:',
    ...node.tags.map((tag) => `  - ${tag}`),
    'links:',
    ...node.links.map((link) => `  - type: "${link.type}"\n    target: "${link.target}"`),
    `supersededBy: ${node.supersededBy ? `"${node.supersededBy}"` : 'null'}`,
    '---',
    '',
    '## Context',
    '',
    node.context,
    '',
    '## Consequences',
    '',
    node.consequences,
    '',
  ];
  return frontmatter.join('\n');
}
