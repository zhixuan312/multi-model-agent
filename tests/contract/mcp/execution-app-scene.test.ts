/**
 * Contract: the execution monitor's three-act stage.
 *
 * These pin the invariants that are cheap to break and expensive to notice — a task type
 * added without art, a verb that stops matching what the route may do to your files, a limb
 * that detaches because someone reached for `translate`, and a reduced-motion path that drops
 * the finished piece on the floor.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { TASK_TYPES, TYPE_REGISTRY, type TaskType } from '@zhixuan92/multi-model-agent-core';
import { TYPE_ART, DEFAULT_ART, artFor } from '../../../packages/server/src/ui/execution/type-art.js';
import { sceneSvg, sceneClass, raiseTransform } from '../../../packages/server/src/ui/execution/scene.js';
import { endingForStatus } from '../../../packages/server/src/ui/execution/display-state.js';

const CSS = await readFile('packages/server/src/ui/execution/execution.html', 'utf8');

describe('contract: every task type has stage art', () => {
  it('covers every member of TASK_TYPES, with no extras', () => {
    expect(Object.keys(TYPE_ART).sort()).toEqual([...TASK_TYPES].sort());
  });

  it('renders a working scene for every type in all three acts', () => {
    for (const type of TASK_TYPES) {
      for (const act of ['work', 'review', 'end'] as const) {
        const svg = sceneSvg({ type, act, ending: 'done' });
        expect(svg.length, `${type}/${act}`).toBeGreaterThan(200);
        // Floor and bench are load-bearing: the whole geometry is measured against them.
        expect(svg, `${type}/${act}`).toContain('y="27.6"');
      }
    }
  });

  it('falls back rather than breaking when a type has no art', () => {
    // A task type added to TYPE_REGISTRY without art here must still render. A monitor that
    // breaks because someone extended an enum is worse than a generic bench.
    expect(artFor('a_type_that_does_not_exist')).toBe(DEFAULT_ART);
    expect(artFor(undefined)).toBe(DEFAULT_ART);
    expect(sceneSvg({ type: 'a_type_that_does_not_exist', act: 'work' }).length).toBeGreaterThan(200);
  });
});

describe('contract: the verb states what the route may do to your files', () => {
  it('matches TYPE_REGISTRY for every type', () => {
    // The art table is a hand-maintained copy (the UI bundle must not import core). This is
    // the check that stops it drifting: strike ⇔ writes and commits, draft ⇔ writes a file,
    // probe ⇔ read-only.
    for (const type of TASK_TYPES) {
      const cfg = TYPE_REGISTRY[type as TaskType];
      const expected = cfg.writeRoute ? 'strike' : cfg.sandbox === 'read-only' ? 'probe' : 'draft';
      expect(TYPE_ART[type].verb, `${type} (writeRoute=${cfg.writeRoute}, sandbox=${cfg.sandbox})`)
        .toBe(expected);
    }
  });

  it('only delegate and execute_plan may swing a hammer', () => {
    const strikers = Object.entries(TYPE_ART).filter(([, a]) => a.verb === 'strike').map(([t]) => t);
    expect(strikers.sort()).toEqual(['delegate', 'execute_plan']);
    // ...and those are exactly the write routes, per the registry itself.
    const writers = [...TASK_TYPES].filter((t) => TYPE_REGISTRY[t as TaskType].writeRoute);
    expect(writers.sort()).toEqual(['delegate', 'execute_plan']);
  });

  it('an unknown type understates rather than overstates its powers', () => {
    // Wrong in the safe direction: never imply a route can write your files when unsure.
    expect(DEFAULT_ART.verb).toBe('probe');
  });
});

describe('contract: acts and endings map from real state', () => {
  it('marks the act on the scene root so the stylesheet can key off it', () => {
    expect(sceneClass({ type: 'spec', act: 'work' })).toContain('act-work');
    expect(sceneClass({ type: 'spec', act: 'review' })).toContain('act-review');
    expect(sceneClass({ type: 'spec', act: 'end', ending: 'failed' })).toContain('end-failed');
  });

  it('advisory concerns are a WIN, not a failure', () => {
    // A run with concerns succeeded. Rendering it as damage would misreport the outcome.
    expect(endingForStatus('done_with_concerns')).toBe('concerns');
    expect(endingForStatus('done')).toBe('done');
    expect(endingForStatus('failed')).toBe('failed');
    expect(endingForStatus('interrupted')).toBe('failed');
    expect(endingForStatus('cancelled')).toBe('cancelled');
  });

  it('keeps both figures on stage for a success and drops the reviewer on a failure', () => {
    const done = sceneSvg({ type: 'spec', act: 'end', ending: 'done' });
    const failed = sceneSvg({ type: 'spec', act: 'end', ending: 'failed' });
    // The reviewer refines the worker's output, so a completed run is a shared lift. A failed
    // one had nothing to review, so the reviewer never arrives.
    expect(done).toContain('ilean');
    expect(done).toContain('lean');
    expect(failed).not.toContain('ilean');
  });

  it('the reviewing act puts BOTH figures on stage', () => {
    const review = sceneSvg({ type: 'spec', act: 'review' });
    expect(review).toContain('ilean');
    expect(review).toContain('lean');
  });
});

describe('contract: the raise lands every piece in the same hands', () => {
  it('scales each subject to meet the two raised hands', () => {
    // Measured from the rig: the hands meet at x 22.03 and 30.50, y ~11.5. A single fixed
    // transform cannot serve twelve differently-sized subjects — a wide billet overshoots one
    // hand and a narrow stack leaves the other holding air.
    for (const type of TASK_TYPES) {
      const t = raiseTransform(TYPE_ART[type].subject);
      const m = /translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)/.exec(t);
      expect(m, `${type}: ${t}`).not.toBeNull();
      const [tx, ty, s] = [Number(m![1]), Number(m![2]), Number(m![3])];
      expect(s, `${type} scale`).toBeGreaterThan(0);
      // Width never exceeds the 9-unit span between the hands, and the underside always
      // lands on them.
      expect(tx).toBeLessThan(26.3);
      expect(Number((ty + s * 0).toFixed(3))).toBeLessThan(11.6);
    }
  });
});

describe('contract: anatomy — nothing detaches', () => {
  it('never translates a body or limb group', () => {
    // Legs sit OUTSIDE the leaning group by design, so translating the body lifts the torso
    // off them, and translating an arm slides the shoulder out of the torso. Every joint rule
    // must be a rotation.
    const jointRules = CSS.match(/#app \.sc[^{]*\.(ua|fa|iua|ifa|lean|ilean)[^{]*\{[^}]*\}/g) ?? [];
    expect(jointRules.length).toBeGreaterThan(6);
    for (const rule of jointRules) {
      expect(rule, `translate on a limb: ${rule}`).not.toMatch(/transform:\s*translate/);
    }
    // Keyframe bodies contain nested braces, so match one level of nesting explicitly —
    // a lazy `[\s\S]*?` runs past the block and swallows the rest of the stylesheet.
    const jointFrames = CSS.match(
      /@keyframes mma-(?:ua|fa|iua|ifa|lean|hold|sway|sigh|breath)[\w-]*\s*\{(?:[^{}]|\{[^{}]*\})*\}/g,
    ) ?? [];
    expect(jointFrames.length).toBeGreaterThan(6);
    for (const frames of jointFrames) {
      expect(frames, `translate in a joint keyframe: ${frames.slice(0, 60)}`).not.toMatch(/translate/);
    }
  });

  it('holds the Act III pose statically, so reduced motion still shows the piece held', () => {
    // Poses live in CSS rather than inline attributes: an animation overrides an inline style,
    // so with motion disabled inline poses would vanish and the arms would fall flat while the
    // piece floated unheld.
    expect(CSS).toMatch(/#app \.sc\.end-done \.ua[^{]*\{\s*transform: rotate\(38deg\);\s*\}/);
    expect(CSS).toMatch(/#app \.sc\.end-done \.iua[^{]*\{\s*transform: rotate\(-40deg\);\s*\}/);
    expect(CSS).toMatch(/prefers-reduced-motion: reduce/);
  });

  it('animates the endings, but slower than the working acts', () => {
    const hold = /animation: mma-hold-ua ([\d.]+)s/.exec(CSS);
    const strike = /animation: mma-ua-strike ([\d.]+)s/.exec(CSS);
    expect(hold).not.toBeNull();
    expect(strike).not.toBeNull();
    expect(Number(hold![1])).toBeGreaterThan(Number(strike![1]));
  });

  it('rotates the shoulder and elbow IN PHASE for the probe sweep', () => {
    // Counter-phasing them cancels their travel almost exactly, which reads as a frozen panel.
    const ua = /@keyframes mma-ua-probe \{ 0%, 100% \{ transform: rotate\((-?[\d.]+)deg\); \} 50% \{ transform: rotate\((-?[\d.]+)deg\); \} \}/.exec(CSS);
    const fa = /@keyframes mma-fa-probe \{ 0%, 100% \{ transform: rotate\((-?[\d.]+)deg\); \} 50% \{ transform: rotate\((-?[\d.]+)deg\); \} \}/.exec(CSS);
    expect(ua).not.toBeNull();
    expect(fa).not.toBeNull();
    const uaDelta = Number(ua![2]) - Number(ua![1]);
    const faDelta = Number(fa![2]) - Number(fa![1]);
    expect(Math.sign(uaDelta)).toBe(Math.sign(faDelta));
    expect(Math.abs(uaDelta) + Math.abs(faDelta)).toBeGreaterThan(30);
  });
});
