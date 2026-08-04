// Manual end-to-end demo for `mma disable` / `enable`.
// Drives the REAL built code against a throwaway home dir — never touches ~/.claude.
//   node scripts/demo-disable-enable.mjs
//
// What changed, and why this script had to change with it: the sticky off-switch
// used to be a sentinel file (`~/.mma/skills-disabled.json`) and provisioning
// installed to every DETECTED client. Both are gone. A client is provisioned only
// when it is DECLARED `on`, and `mma disable` persists `clients.<id>: "off"` into
// the config file itself — which is why a config file now has to exist before
// either command will mutate anything. Without one, disable refuses rather than
// performing an action that would not survive a restart.
//
// The previous version of this script demonstrated nothing: it declared no
// clients, so every step no-opped, and it still printed a ✅ at the end. Step 3's
// "still 0 means disable survived" was vacuously true because nothing had ever
// been installed. Each step below now asserts, and a wrong count exits non-zero.
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.resolve('packages/server/dist');
if (!existsSync(path.join(dist, 'cli', 'toggle.js'))) {
  console.error('Built output not found. Run `pnpm run build` first, then re-run this script.');
  process.exit(1);
}
const imp = (p) => import(pathToFileURL(path.join(dist, p)).href);
const { runSyncSkills } = await imp('cli/sync-skills.js');
const { runDisable, runEnable } = await imp('cli/toggle.js');

const HOME = mkdtempSync(path.join(tmpdir(), 'mma-demo-'));
const skillsRoot = path.join(dist, 'skills');
mkdirSync(path.join(HOME, '.claude'), { recursive: true });   // so detection sees a client
mkdirSync(path.join(HOME, '.codex'), { recursive: true });
mkdirSync(path.join(HOME, '.mma'), { recursive: true });

// A declaration has to be durable, so it needs somewhere to live.
const configPath = path.join(HOME, '.mma', 'config.json');
writeFileSync(configPath, JSON.stringify({ clients: { 'claude-code': 'on' } }, null, 2) + '\n');

const claudeSkills = path.join(HOME, '.claude', 'skills');
const count = () => (existsSync(claudeSkills) ? readdirSync(claudeSkills).filter((n) => n.startsWith('mma-')).length : 0);
const declared = () => JSON.parse(readFileSync(configPath, 'utf8')).clients ?? {};
const step = (n, msg) => console.log(`\n── ${n}. ${msg}`);

let failures = 0;
function expect(label, actual, predicate, expectation) {
  const ok = predicate(actual);
  if (!ok) failures += 1;
  console.log(`   ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}${ok ? '' : `  (expected ${expectation})`}`);
}

console.log(`fake HOME = ${HOME}`);
console.log(`declared  = ${JSON.stringify(declared())}`);

step(1, 'install skills for the declared client (sync-skills)');
await runSyncSkills({ argv: [], homeDir: HOME, skillsRoot, declared: declared(), configPath });
expect('claude skills on disk', count(), (n) => n > 0, 'more than 0');

const installed = count();

step(2, 'disable --target=claude-code');
await runDisable({ argv: ['--target=claude-code'], homeDir: HOME, declared: declared(), configPath });
expect('claude skills on disk', count(), (n) => n === 0, '0');
expect('persisted declaration', declared()['claude-code'], (v) => v === 'off', '"off"');

step(3, 'sticky check: sync-skills again (this is what npm postinstall does)');
await runSyncSkills({ argv: [], homeDir: HOME, skillsRoot, declared: declared(), configPath });
expect('claude skills on disk', count(), (n) => n === 0, '0 — the off declaration survived');

step(4, 'enable --target=claude-code');
await runEnable({ argv: ['--target=claude-code'], homeDir: HOME, skillsRoot, declared: declared(), configPath });
expect('claude skills on disk', count(), (n) => n === installed, `${installed} — every skill back`);
expect('persisted declaration', declared()['claude-code'], (v) => v === 'on', '"on"');

rmSync(HOME, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} check(s) failed. ✗`);
  process.exit(1);
}
console.log('\ncleaned up. ✅');
