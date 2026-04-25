type Primitive = string | number | boolean | null;

export interface VerboseLineFields {
  event: string;
  ts: string;
  batch?: string;
  task?: number;
  preview?: string;
  [key: string]: Primitive | undefined;
}

const BARE_VALUE = /^[A-Za-z0-9_./:+-]+$/;
const KEY_NAME = /^[a-z][a-z0-9_]*$/;

function escapeValue(v: Primitive): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);

  const needsQuote = !BARE_VALUE.test(v);
  if (!needsQuote) return v;

  let out = '';
  for (const ch of v) {
    const code = ch.charCodeAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return `"${out}"`;
}

const STRUCT_KEY_FORBIDS_NEWLINE = (key: string) => key !== 'preview';

function assertValidKey(key: string): void {
  if (!KEY_NAME.test(key)) {
    throw new Error(`verbose-line: invalid key name (key=${key})`);
  }
}

function assertPrimitiveValue(key: string, val: unknown): asserts val is Primitive | undefined {
  if (val === undefined) return;
  if (val === null) return;
  const t = typeof val;
  if (t !== 'string' && t !== 'number' && t !== 'boolean') {
    throw new Error(`verbose-line: non-primitive value (key=${key})`);
  }
}

export function composeVerboseLine(fields: VerboseLineFields): string {
  const { event, ts, ...rest } = fields;
  if (!event) throw new Error('verbose-line: event is required');
  if (!ts) throw new Error('verbose-line: ts is required');
  if (/[\n\r]/.test(event) || /[\n\r]/.test(ts)) {
    throw new Error('verbose-line: event/ts must not contain newlines');
  }

  assertValidKey('event');
  assertValidKey('ts');
  assertPrimitiveValue('event', event);
  assertPrimitiveValue('ts', ts);

  const orderedKeys = [
    'batch',
    'task',
    ...Object.keys(rest).filter((k) => k !== 'batch' && k !== 'task' && k !== 'preview'),
    'preview',
  ];
  const parts: string[] = [`event=${escapeValue(event)}`, `ts=${escapeValue(ts)}`];

  for (const key of orderedKeys) {
    assertValidKey(key);
    const val = rest[key];
    assertPrimitiveValue(key, val);
    if (val === undefined) continue;
    if (typeof val === 'string' && /[\n\r]/.test(val) && STRUCT_KEY_FORBIDS_NEWLINE(key)) {
      throw new Error(`verbose-line: non-preview value contains newline (key=${key})`);
    }
    parts.push(`${key}=${escapeValue(val)}`);
  }

  return `[mmagent verbose] ${parts.join(' ')}`;
}
