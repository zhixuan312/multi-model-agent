---
id: "0017"
title: "Treat disabled network tests as missing critical-path coverage"
category: "process"
status: "adopted"
tags:
  - testing
  - ssrf
  - network-gated
  - ci
  - regression
  - deterministic-tests
  - web-fetch
  - dns
links:
  - type: "relates"
    target: "0001"
  - type: "relates"
    target: "0003"
supersededBy: null
date: "2026-05-24"
---

## Context
The web-fetch SSRF connect guard shipped with a production-breaking contract bug because the only test that exercised the guarded path was network-gated and off by default. The guard called `dns.lookup` without forwarding Undici's `connect.lookup` options, then returned the single-result shape `{address, family}` even when Undici invoked the hook with `{all: true}` and expected an array. Undici then read `addresses[0].address` from `undefined`, threw `ERR_INVALID_IP_ADDRESS`, and every production `webFetch` routed through the guard failed at connect time.

The regression stayed invisible in releases because the sole path-level test required real network access and did not run in CI. That meant the project had a nominal test for the feature but no deterministic coverage for the production contract. The durable fix was to forward the caller's lookup options to `dns.lookup`, re-run the SSRF classifier over each resolved IP, return the array form when `{all: true}` is requested, and lock the behavior with three deterministic unit tests that mock resolution and run without network access.

## Consequences
A network-gated test that is disabled in CI does not count as coverage for a critical path. Treat it as optional smoke only; the real regression barrier must be a deterministic test that runs on every change.

For security or connectivity hooks that adapt another library's callback contract, test the exact production call shapes under mock control. Include shape-sensitive cases such as single-result versus array-result lookup responses so adapter bugs fail in CI instead of at runtime.

When a production path depends on DNS, sockets, or remote services, keep at least one no-network unit test that exercises the control flow with mocked inputs and asserts the contract at the boundary. Real-network tests can supplement this, but they cannot be the only executable evidence that the path works.
