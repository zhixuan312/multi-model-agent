// Per the v5 wire envelope, RunResult IS the ComposePayload shape.
// This file remains as a stable import path; the truth lives in stage-io.ts.
export type { ComposePayload as RunResult } from '../lifecycle/stage-io.js';