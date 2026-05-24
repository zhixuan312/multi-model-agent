---
id: "0020"
title: "Route all lifecycle control through the single invocation surface"
status: "adopted"
tags:
  - architecture
  - product
  - invocation-path
  - mcp
  - skills
  - disable
  - adapters
  - daemon
date: "2026-05-24"
links:
  - type: "relates"
    target: "0008"
  - type: "relates"
    target: "0002"
supersededBy: null
---

## Context
The product's architecture hardened around a single caller entry surface, and that choice determined both the runtime shape and the off-switch. In v0.1.0, the system shipped as an MCP stdio server exposing `delegate_tasks`, with capability-based auto-routing across providers behind that one tool surface. Later releases moved execution into a local HTTP daemon, but callers were still meant to reach it through exactly one adapter layer: the installed `mma-*` skill files. That adapter surface became the real invocation path of the product, even though the daemon remained the execution engine underneath.

That distinction mattered most once disablement became a product requirement. In v4.7.18, the supported `mmagent disable` flow did not stop, edit, or uninstall the daemon. Instead, it removed the skill adapter files and wrote an upgrade-surviving sentinel. Postinstall sync then honored that sentinel so upgrades would not silently restore the adapters and re-enable the product against user intent. The durable lesson is that enable and disable semantics belong at the sole invocation layer, not at some lower runtime component that callers do not touch directly.

The product therefore evolved from "an MCP server with routing logic" into "a delegation substrate reached through one well-defined adapter surface." Once that surface is singular and explicit, lifecycle control follows naturally: changing transports underneath, such as MCP stdio to local HTTP, does not change the caller contract, and turning the product off becomes a clean withdrawal of the only supported entry point rather than a fragile cleanup of files that an install step will recreate.

## Consequences
Choose one invocation surface deliberately and treat it as the product boundary. If the runtime engine, transport, or orchestration layer changes underneath, preserve that single caller path rather than letting multiple entry points accumulate.

Lifecycle controls such as enable, disable, install sync, and upgrade behavior must operate through the same adapter layer that callers use. If disabling requires manual cleanup of lower-level runtime pieces that the installer later restores, the architecture has put control in the wrong place.

When a user deliberately disables the product, persist that intent at the invocation layer with an upgrade-surviving marker and make reinstall or postinstall flows honor it. User intent to disable must outrank convenience reinstallation.

During review, treat parallel invocation surfaces as a product-design risk. Multiple supported entry paths make transport migrations harder, split lifecycle authority, and turn simple operations like disablement into inconsistent, leaky behavior.
