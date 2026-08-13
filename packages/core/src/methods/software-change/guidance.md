# Software change — Method guidance

**Method:** `software-change@1`
**Purpose:** Change software safely to satisfy a defined need.
**Required inputs:** source code; requested behavior; acceptance criteria
**Expected outputs:** changed source code; test evidence

A contract stated in prose still has to hold against the real, running system. Apply every
section below to the code you wrote or changed before reporting the work done — a contract
satisfied on paper but not in the running system is not satisfied.

## Caller tracing

Before reporting the work done, trace every caller of a function signature, exported type, or
public shape you changed, across the whole workspace, and update each one. A change that
satisfies the contract for the named files but breaks an unnamed caller is not a satisfied
contract — grep for the changed symbol's name and inspect every match, not only the files the
task originally listed.

## Error-path review

Before calling a task done, review every error condition the contract's `Errors` bullet names
and confirm each one is reachable and produces the stated outcome — the declared thrown type,
status code, or return shape — not just the happy path. Write or extend the implementation so
the error branch is real, exercised code; an error path that exists only in the contract's prose
and never runs in the implementation is not implemented.

## Security-sink review

As part of every change, validate or escape any external or caller-supplied input before it
reaches a sink — a shell command, a file path, a database query, HTML output, or `eval` — rather
than assuming some other layer already did. Do not trust upstream validation you have not
personally read; confirm the validation runs in the code path that actually executes the sink,
not in a sibling path that only looks similar.

## Schema conformance

Before calling a change conformant, check the implementation's actual runtime shape against the
type or wire schema the contract's `Data mapping` or `Outputs / Response` bullet names,
field-for-field, by reading the schema's definition at its current source location rather than a
paraphrase or memory of it. A mismatch between the runtime shape and the schema definition is a
defect even when every existing test passes.

## Test adequacy

Before reporting the task done, assess whether the acceptance tests exercise every error path and
boundary value the contract states, not only its happy path, and add a supplementary test near
the acceptance test when a gap remains and doing so does not conflict with a rule against editing
plan-authored or acceptance tests. A test suite that proves only the happy path leaves the
contract's other clauses unverified.
