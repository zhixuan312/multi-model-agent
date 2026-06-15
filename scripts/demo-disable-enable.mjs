// Manual end-to-end demo for `mma disable` / `enable`.
// Drives the REAL built code against a throwaway home dir — never touches ~/.claude.
//   node scripts/demo-disable-enable.mjs
import { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.resolve('packages/server/dist');
if (!existsSync(path.join(dist, 'cli', 'toggle.js'))) {
  console.error('Built output not found. Run `npm run build` first, then re-run this script.');
  process.exit(1);
}
const imp = (p) => import(pathToFileURL(path.join(dist, p)).href);
const { runSyncSkills } = await imp('cli/sync-skills.js');
const { runDisable, runEnable } = await imp('cli/toggle.js');

const HOME = mkdtempSync(path.join(tmpdir(), 'mma-demo-'));
const skillsRoot = path.join(dist, 'skills');
mkdirSync(path.join(HOME, '.claude'), { recursive: true });   // so detectClients sees a client
mkdirSync(path.join(HOME, '.codex'), { recursive: true });

const claudeSkills = path.join(HOME, '.claude', 'skills');
const sentinel = path.join(HOME, '.mma', 'skills-disabled.json');
const count = () => (existsSync(claudeSkills) ? readdirSync(claudeSkills).length : 0);
const step = (n, msg) => console.log(`\n── ${n}. ${msg}`);

console.log(`fake HOME = ${HOME}`);

step(1, 'install skills (sync-skills)');
await runSyncSkills({ argv: [], homeDir: HOME, skillsRoot });
console.log(`   claude skills on disk: ${count()}   sentinel: ${existsSync(sentinel)}`);

step(2, 'disable');
await runDisable({ argv: [], homeDir: HOME, cliVersion: 'demo' });
console.log(`   claude skills on disk: ${count()}   sentinel: ${existsSync(sentinel)}`);

step(3, 'sticky check: run sync-skills again (this is what npm postinstall does)');
await runSyncSkills({ argv: [], homeDir: HOME, skillsRoot });
console.log(`   claude skills on disk: ${count()}   <- still 0 means disable survived the upgrade`);

step(4, 'enable');
await runEnable({ argv: [], homeDir: HOME, skillsRoot });
console.log(`   claude skills on disk: ${count()}   sentinel: ${existsSync(sentinel)}`);

rmSync(HOME, { recursive: true, force: true });
console.log('\ncleaned up. ✅');
