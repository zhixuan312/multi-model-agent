---
id: "0044"
title: "Audit dead code across production and test imports"
category: "knowledge"
status: "adopted"
tags:
  - dead-code
  - cleanup
  - exports
  - config-schema
  - test-helpers
  - fixtures
  - grep-audit
date: "2026-06-13"
links:
  - type: "refines"
    target: "0002"
  - type: "relates"
    target: "0019"
supersededBy: null
---

## Context
Dead code accumulated in predictable places during the cleanup work. Config schema fields survived after feature removal, including nine unused defaults fields from the deleted lifecycle layer. `package.json` exports survived file deletion, such as `bounded-execution/file-artifact-check` pointing to a nonexistent file. Test helpers survived deletion of the code they tested, and orphaned fixtures accumulated with broken imports.

Grep-based audits that count exported-symbol importers catch these patterns, but only when they include both production and test imports. An audit that checks production code alone falsely flags legitimate test utilities as dead.

## Consequences
Periodic dead-code audits should scan config schemas, package exports, test helpers, fixtures, and deleted-file import surfaces. These are the predictable residue points after feature removal.

Use grep-based exported-symbol-to-importer counts as a cheap first pass, but include production and test code before deleting anything. Test-only usage is still usage.

When removing a feature, check package metadata and fixtures in the same cleanup window. Broken exports and stale fixtures often survive because they are outside the immediate implementation files.
