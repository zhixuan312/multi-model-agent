/**
 * The daemon's record of itself.
 *
 * The behaviour under test is not "JSON round-trips". It is that a caller can
 * never be handed a record it would act on wrongly: a half-written or truncated
 * file must read as ABSENT, because the alternative is signalling a pid that
 * was recorded without the port that proves whose pid it is.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pidfilePath, readPidfile, removePidfile, writePidfile, type DaemonRecord } from '../../packages/server/src/pidfile.js';

let dir: string;

const record: DaemonRecord = {
  pid: 4242,
  port: 7337,
  bind: '127.0.0.1',
  version: '6.4.0',
  bootId: 'boot-abc',
  startedAt: 1_700_000_000_000,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mma-pidfile-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('round-trips a complete record', () => {
  expect(writePidfile(dir, record)).toBe(true);
  expect(readPidfile(dir)).toEqual(record);
});

it('creates the state directory when it does not exist yet', () => {
  const nested = join(dir, 'does', 'not', 'exist');
  expect(writePidfile(nested, record)).toBe(true);
  expect(readPidfile(nested)).toEqual(record);
});

it('reads as absent when there is no file', () => {
  expect(readPidfile(dir)).toBeNull();
});

it('reads as absent when the file is not JSON', () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(pidfilePath(dir), '{ truncated');
  expect(readPidfile(dir)).toBeNull();
});

// The important one. A record missing `port` still has a pid, and a caller that
// accepted it would fall back to signalling on the pid alone — exactly the
// unverified kill this whole mechanism replaces.
it.each([
  ['port', { ...record, port: undefined }],
  ['pid', { ...record, pid: undefined }],
  ['bind', { ...record, bind: undefined }],
  ['version', { ...record, version: undefined }],
  ['bootId', { ...record, bootId: undefined }],
  ['startedAt', { ...record, startedAt: undefined }],
])('reads as absent when %s is missing', (_field, partial) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(pidfilePath(dir), JSON.stringify(partial));
  expect(readPidfile(dir)).toBeNull();
});

it.each([
  ['a zero pid', { ...record, pid: 0 }],
  ['a negative pid', { ...record, pid: -1 }],
  ['a non-integer pid', { ...record, pid: 1.5 }],
  ['a zero port', { ...record, port: 0 }],
  ['an empty bind', { ...record, bind: '' }],
])('reads as absent for %s', (_case, bad) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(pidfilePath(dir), JSON.stringify(bad));
  expect(readPidfile(dir)).toBeNull();
});

it('removes the record, and removing a missing one is not an error', () => {
  writePidfile(dir, record);
  expect(existsSync(pidfilePath(dir))).toBe(true);
  removePidfile(dir);
  expect(existsSync(pidfilePath(dir))).toBe(false);
  expect(() => removePidfile(dir)).not.toThrow();
});

it('reports failure instead of throwing when the write cannot happen', () => {
  // A path whose parent is a FILE cannot be made into a directory. The daemon
  // must still start, so this reports false rather than raising.
  const blocked = join(dir, 'a-file', 'state');
  writeFileSync(join(dir, 'a-file'), 'not a directory');
  expect(writePidfile(blocked, record)).toBe(false);
});
