---
id: "0019"
title: "Treat runtime imports as shipping dependencies and validate from a clean published artifact"
status: "adopted"
tags:
  - packaging
  - dependencies
  - peer-deps
  - npm
  - publishing
  - clean-install
  - hoisting
  - npx
  - bins
date: "2026-05-24"
links:
  - type: "relates"
    target: "0001"
supersededBy: null
---

## Context
In v0.1.2, the published package crashed for end users on first dispatch because `openai` and `@openai/agents` were declared as optional peer dependencies even though the shipped source imported them at runtime. `npm` and `npx` therefore did not install those packages for consumers, and `npx @zhixuan92/multi-model-agent-mcp serve` failed with `Cannot find package 'openai'`.

The development monorepo hid the defect completely. Both libraries were present in the root workspace `devDependencies`, and hoisting made them appear available to the package under test even though the published artifact did not actually guarantee them. The fix was to move those libraries into regular `dependencies` on the package whose runtime source imports them.

The same packaging boundary had already produced a sibling release defect in v0.1.1: a bin file emitted with mode `0644` caused npm to strip the bin entry during publish until the package added a `prepublishOnly` chmod step. The durable pattern across both incidents is that local workspace state is not evidence about the artifact users install. Hoisting, root dependencies, and existing filesystem permissions can all make a broken package look healthy in development.

## Consequences
If shipped code imports a package at runtime, that package belongs in `dependencies` of the published package that imports it. Optional peer dependencies are only valid when the package can genuinely run without them.

Release validation must exercise the packed or published artifact from a clean environment, not from the development workspace. A clean `npm` or `npx` install is the only reliable way to catch missing runtime dependencies, stripped bin entries, and similar packaging defects that hoisting masks.

When reviewing package metadata, treat workspace-hoisted success as non-evidence. Validate the package boundary directly: dependency declarations, executable bit preservation for bins, and consumer install behavior must all be proven outside the monorepo.
