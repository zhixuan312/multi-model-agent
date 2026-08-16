import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, it, expect } from 'vitest';

/**
 * End-to-end smoke over the REAL built bundle, driven by payloads captured from a live run.
 *
 * Every other test in this area exercises `entry.ts` and `scene.ts` as modules. That leaves
 * the shipped-artifact failure mode uncovered: the modules are perfect, the bundle is wrong.
 * These assertions parse the actual `dist` bytes and drive them through all three acts with
 * the shape a real daemon emits.
 *
 * This file runs in the DEFAULT node environment (the `JSDOM` constructor needs no ambient
 * DOM) — do not add an environment pragma; the sibling artifact test explains why in detail.
 */
const artifactPath = resolve(process.cwd(), 'packages/server/dist/ui/execution.html');

/** Payloads shaped exactly like a real `investigate` run: poll, poll, terminal envelope. */
const ACT_I = {
  executionId: 'd423b24c', type: 'investigate', cwd: '/repo', status: 'running',
  phase: 'implementing', elapsedMs: 12_000, phaseElapsedMs: 12_000,
  runningHeadline: "Running sed -n '1,240p' /repo/scene.ts",
};
const ACT_II = { ...ACT_I, phase: 'reviewing', elapsedMs: 61_000, phaseElapsedMs: 13_000, runningHeadline: 'Read: …/scene.test.ts' };
const TERMINAL = {
  execution: { executionId: 'd423b24c', type: 'investigate', status: 'done' },
  metrics: {
    totalDurationMs: 101_984, totalCostUsd: 0.4045074, savedVsMainCostUsd: 0.3073751,
    implementer: { durationMs: 45_069, costUsd: 0.1475505 },
    reviewer: { durationMs: 56_881, costUsd: 0.2569569 },
    totalUsage: { inputTokens: 39_475, outputTokens: 6900, cachedReadTokens: 288_540, cachedNonReadTokens: 31_638 },
  },
  output: { summary: { answer: 'SECRET-ANSWER-TEXT' }, filesChanged: [] },
};

async function driveBuiltPanel() {
  const html = readFileSync(artifactPath, 'utf8');
  // jsdom does not execute <script type="module">, and the singlefile plugin owns the tag
  // attributes, so extracting the module body and evaluating it is the only way to run the
  // bytes that actually ship.
  const script = /<script[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  expect(script, 'built bundle has no module script').toBeTruthy();
  const evaluatable = script!.replace(/import\.meta\.url/g, JSON.stringify('https://app.local/execution.html'));

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://app.local/', pretendToBeVisual: true });
  const { window } = dom;
  let deliver: (v: unknown) => void = () => {};
  let last = '{}';
  const calls: string[] = [];
  (window as unknown as { __MMA_CREATE_APP__: () => unknown }).__MMA_CREATE_APP__ = () => ({
    connect: () => Promise.resolve(),
    set ontoolresult(fn: (v: unknown) => void) { deliver = fn; },
    get ontoolresult() { return deliver; },
    callServerTool: (p: { name: string }) => {
      calls.push(p.name);
      return Promise.resolve({ content: [{ type: 'text', text: last }] });
    },
  });
  (window as unknown as { eval(s: string): unknown }).eval(evaluatable);

  const tick = () => new Promise((r) => { window.setTimeout(r, 30); });
  const send = async (payload: unknown) => {
    last = JSON.stringify(payload);
    deliver?.({ content: [{ type: 'text', text: last }] });
    await tick();
  };
  await tick();
  return { doc: window.document, send, calls, sceneClass: () => window.document.querySelector('.stage svg')?.getAttribute('class') ?? '' };
}

describe('smoke: the built panel plays all three acts', () => {
  it('drives Act I → Act II → Act III on real payload shapes', async () => {
    const { doc, send, calls, sceneClass } = await driveBuiltPanel();
    expect(doc.getElementById('app')).not.toBeNull();

    // ── Act I ──
    await send(ACT_I);
    expect(sceneClass()).toContain('act-work');
    // investigate is read-only, so it must never be given a hammer.
    expect(sceneClass()).toContain('v-probe');
    expect(doc.querySelector('h2')?.textContent).toMatch(/^investigate/);
    expect(doc.body.textContent).toContain('sed -n');
    expect(doc.querySelector('.hd button'), 'stop control belongs in the header').not.toBeNull();
    expect(doc.querySelector('.tbl'), 'no results while running').toBeNull();
    expect(doc.querySelector('.stage svg')?.innerHTML, 'reviewer has not arrived yet').not.toContain('ilean');

    // ── Act II: the reviewer joins; the worker stays ──
    await send(ACT_II);
    expect(sceneClass()).toContain('act-review');
    const reviewSvg = doc.querySelector('.stage svg')?.innerHTML ?? '';
    expect(reviewSvg).toContain('ilean');
    expect(reviewSvg).toContain('"lean"');
    const acts = [...doc.querySelectorAll('.strip .bar')]
      .map((b) => (b.classList.contains('p2') ? 2 : b.classList.contains('p1') ? 1 : 0))
      .filter(Boolean);
    expect(acts.every((a, i) => i === 0 || a >= acts[i - 1]), `strip order ${acts.join(',')}`).toBe(true);

    // ── Act III ──
    await send(TERMINAL);
    expect(sceneClass()).toContain('end-done');
    const endSvg = doc.querySelector('.stage svg')?.innerHTML ?? '';
    expect(endSvg, 'the piece is raised').toContain('held');
    expect(endSvg, 'both figures stay for a success').toContain('ilean');
    expect(doc.querySelector('.bd .stage'), 'row one survives into Act III').not.toBeNull();
    expect(doc.querySelector('.stage')?.getAttribute('style'), 'stage size is CSS-only, never per-act').toBeNull();
    expect(doc.querySelectorAll('.tbl .cel').length).toBeGreaterThanOrEqual(5);

    const text = doc.body.textContent ?? '';
    expect(text).toContain('1m 41s');
    expect(text).toContain('$0.40');
    expect(text).toContain('Saved vs main');
    expect(text).toContain('Implementer');
    expect(text).toContain('Reviewer');
    expect(text).toContain('cached');
    expect(text, 'read-only route wrote nothing').not.toContain('Files changed');
    expect(text, 'the panel is a monitor, not a result viewer').not.toContain('SECRET-ANSWER-TEXT');
    expect(text).not.toMatch(/undefined|NaN/);
    expect(doc.querySelector('button'), 'nothing left to cancel').toBeNull();
    expect(calls.every((c) => c === 'mma_execution_get'), calls.join(',')).toBe(true);
  });

  it('maps every terminal status onto its own tableau', async () => {
    const { send, sceneClass } = await driveBuiltPanel();
    for (const [status, expected] of [
      ['done', 'end-done'],
      ['done_with_concerns', 'end-concerns'],
      ['failed', 'end-failed'],
      ['interrupted', 'end-failed'],
      ['cancelled', 'end-cancelled'],
    ] as const) {
      await send({ ...TERMINAL, execution: { ...TERMINAL.execution, status } });
      expect(sceneClass(), `status ${status}`).toContain(expected);
    }
  });
});
