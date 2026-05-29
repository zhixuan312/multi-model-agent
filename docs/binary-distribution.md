# Binary distribution (5.0.0+) — release cutover runbook

How mmagent ships as a standalone Bun-compiled binary, and the steps `/release`
must perform for the 5.0.0 publish cutover.

## The decision (issue #8: dist-JS vs binary)

Two build outputs coexist, with **distinct, non-overlapping roles** — this is deliberate, not drift:

| Output | Producer | Role | Published? |
|---|---|---|---|
| `packages/server/dist/` (JS) | `tsc` | **Dev / from-source runtime** (`bun run`, the workspace, tests) + `.d.ts` for `@zhixuan92/multi-model-agent-core` consumers | core: yes; server dist-JS: **no** (in the binary distribution) |
| per-platform binaries | `bun build --compile` | **The shipped product** — `@zhixuan92/multi-model-agent` consumers get a standalone binary (Bun embedded) | **yes** |

**Decision: dist-JS is the from-source/dev path and is NOT the published server runtime in 5.0.0.** The published `@zhixuan92/multi-model-agent` is the thin binary-resolver package + per-platform binary packages. dist-JS is retained because (a) `@zhixuan92/multi-model-agent-core` is still consumed as a normal JS/types library, and (b) `bun run packages/server/dist/cli/index.js` is the from-source run path. It is not a "fallback" inside the published binary package — that package contains only the resolver shim + postinstall (`files: [bin, postinstall.mjs]`), no dist.

## What gets published (the shape `scripts/build-binaries.mjs` emits under `binaries/`)

- **8 platform packages** `@zhixuan92/mmagent-<os>-<arch>[-musl]` — each = one binary + `os`/`cpu`/`libc` selectors (`binaries/<target>/`).
- **1 thin top-level** `@zhixuan92/multi-model-agent` (`binaries/_toplevel/`):
  - `bin` → `bin/mmagent.mjs` (Node resolver shim; picks the matching platform package and execs its binary).
  - `optionalDependencies` → all 8 platform packages (npm installs only the host's).
  - `postinstall` → runs `sync-skills` through the resolved binary.
  - `engines.node >=18` — npm uses Node only to run the shim/postinstall; the binary itself needs neither Node nor Bun.

## /release cutover steps (5.0.0)

1. `bun run build` (gen embedded skills + tsc) — verifies the source builds.
2. `bun run test` — full per-file-isolated suite green.
3. `bun scripts/build-binaries.mjs` — compile all 8 targets + emit the 9 packages under `binaries/`.
   (CI's matrix has already executed each platform's binary; locally `npm run smoke:full --build-only` covers host + Docker linux.)
4. Publish the **8 platform packages first** (`binaries/<target>/`), then the **top-level** (`binaries/_toplevel/`) as `@zhixuan92/multi-model-agent` — order matters so the optionalDependencies resolve on install.
5. The source `packages/server/package.json` keeps `bin: dist/cli/index.js` for the dev/from-source path; it is NOT what gets published as the binary distribution. (Do not flip it in-repo — the published artifact is `binaries/_toplevel`.)

## Platform coverage

darwin/linux/windows × x64/arm64 + linux musl (Alpine). 64-bit only. Dropped tail
(vs Node): 32-bit, BSD, s390x/ppc64le, Solaris/AIX — outside the realistic audience.
Alpine consumers need `libstdc++`/`libgcc` (Bun musl binaries link the C++ runtime;
`node:alpine` images already include them).
