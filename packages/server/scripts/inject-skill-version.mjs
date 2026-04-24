#!/usr/bin/env node
/**
 * inject-skill-version.mjs
 *
 * Stamps the server package.json version into every SKILL.md under
 * packages/server/dist/skills/ after tsc + skill copy. Source files carry
 * version: "0.0.0-unreleased" so installed skills always ship with an
 * honest, release-specific version string.
 *
 * Fails loudly if any SKILL.md under dist is missing the version field.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const distRoot = join(here, '..', 'dist', 'skills');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name === 'SKILL.md') out.push(p);
  }
  return out;
}

let count = 0;
for (const file of walk(distRoot)) {
  const raw = readFileSync(file, 'utf8');
  const parsed = matter(raw);
  if (parsed.data.version === undefined) {
    console.error(`inject-skill-version: ${file} missing version frontmatter`);
    process.exit(1);
  }
  parsed.data.version = pkg.version;
  writeFileSync(file, matter.stringify(parsed.content, parsed.data));
  count++;
}
console.log(`inject-skill-version: updated ${count} files to ${pkg.version}`);
