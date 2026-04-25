---
name: mma-investigate
description: Answer a question about the codebase via the local mmagent HTTP service. A sub-agent investigates with read-only filesystem tools and returns a structured answer with file:line (or file:line-range) citations, confidence, and unresolved questions. Stays out of the main agent's context window.
when_to_use: The main agent has a question about the codebase ("how does X work", "where is Y called", "what does this directory do") AND mmagent is running. Delegate the read/grep/synthesis to a mmagent worker — main context stays free for judgment. Codebase only — does not perform web research or git-history queries.
version: "3.4.0"
---
---
