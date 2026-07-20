import { deriveDefaultOutputPath } from '../../../packages/server/src/http/handlers/derive-output-path.js';

const TODAY = '2026-07-11';

describe('deriveDefaultOutputPath', () => {
  // ── Artifact root: everything lives under .mma/ next to the journal ──
  describe('artifact root (.mma/, not docs/mma/)', () => {
    it('spec defaults under .mma/specs/', () => {
      const out = deriveDefaultOutputPath({ type: 'spec', prompt: 'Add caching', today: TODAY });
      expect(out).toBe('.mma/specs/2026-07-11-add-caching.md');
      expect(out!.startsWith('.mma/specs/')).toBe(true);
      expect(out).not.toContain('docs/mma');
    });

    it('plan defaults under .mma/plans/', () => {
      const out = deriveDefaultOutputPath({ type: 'plan', prompt: 'Plan it', paths: ['/p/spec.md'], today: TODAY });
      expect(out).toBe('.mma/plans/2026-07-11-spec.md');
      expect(out!.startsWith('.mma/plans/')).toBe(true);
      expect(out).not.toContain('docs/mma');
    });
  });

  // ── Spec self-naming fallback (no dated input) ──
  describe('spec slug (self-naming — no dated input)', () => {
    it('kebab-cases the first sentence of the prompt', () => {
      expect(deriveDefaultOutputPath({ type: 'spec', prompt: 'Input Validation for the Math Module', today: TODAY }))
        .toBe('.mma/specs/2026-07-11-input-validation-for-the-math-module.md');
    });

    it('uses only the first sentence (stops at . ! ? or newline)', () => {
      expect(deriveDefaultOutputPath({ type: 'spec', prompt: 'Guard divide by zero. Then refactor later.', today: TODAY }))
        .toBe('.mma/specs/2026-07-11-guard-divide-by-zero.md');
    });

    it('falls back to "spec" when the prompt slugifies to empty', () => {
      expect(deriveDefaultOutputPath({ type: 'spec', prompt: '!!! ??? ...', today: TODAY }))
        .toBe('.mma/specs/2026-07-11-spec.md');
    });

    it('truncates the slug to 60 characters', () => {
      const longFirstSentence = 'a'.repeat(80);
      const out = deriveDefaultOutputPath({ type: 'spec', prompt: longFirstSentence, today: TODAY })!;
      const slug = out.replace('.mma/specs/2026-07-11-', '').replace('.md', '');
      expect(slug).toBe('a'.repeat(60));
      expect(slug.length).toBe(60);
    });

    it('skips an UNDATED target.path and self-names from the prompt (AC-2)', () => {
      expect(deriveDefaultOutputPath({ type: 'spec', prompt: 'Add caching', paths: ['/x/y.md'], today: TODAY }))
        .toBe('.mma/specs/2026-07-11-add-caching.md');
    });
  });

  // ── Spec stem inheritance (dated input present) ──
  describe('spec stem inheritance (dated input present)', () => {
    it('inherits the stem from a dated exploration path (AC-1)', () => {
      expect(deriveDefaultOutputPath({
        type: 'spec',
        prompt: 'Whatever the prompt says',
        paths: ['.mma/explorations/2026-07-13-artifact-stem-inheritance.md'],
        today: TODAY,
      })).toBe('.mma/specs/2026-07-13-artifact-stem-inheritance.md');
    });

    it('skips the undated scaffold and inherits the dated exploration, order [undated, dated] (AC-1)', () => {
      expect(deriveDefaultOutputPath({
        type: 'spec',
        prompt: 'X',
        paths: ['/scratch/decisions.md', '.mma/explorations/2026-07-13-artifact-stem-inheritance.md'],
        today: TODAY,
      })).toBe('.mma/specs/2026-07-13-artifact-stem-inheritance.md');
    });

    it('uses the FIRST dated basename when multiple inputs are dated', () => {
      expect(deriveDefaultOutputPath({
        type: 'spec',
        prompt: 'X',
        paths: ['.mma/explorations/2026-07-13-first.md', '.mma/explorations/2026-07-10-second.md'],
        today: TODAY,
      })).toBe('.mma/specs/2026-07-13-first.md');
    });

    it('inherited stem overrides the prompt slug entirely', () => {
      expect(deriveDefaultOutputPath({
        type: 'spec',
        prompt: 'A totally different title that must NOT become the slug',
        paths: ['.mma/explorations/2026-07-13-artifact-stem-inheritance.md'],
        today: TODAY,
      })).toBe('.mma/specs/2026-07-13-artifact-stem-inheritance.md');
    });
  });

  // ── Plan basename derivation ──
  describe('plan basename', () => {
    it('derives the plan name from an undated source basename, prefixed with today', () => {
      expect(deriveDefaultOutputPath({ type: 'plan', prompt: 'Plan', paths: ['/project/design/claims-demo.md'], today: TODAY }))
        .toBe('.mma/plans/2026-07-11-claims-demo.md');
    });

    it('reuses an existing YYYY-MM-DD- prefix on the source basename (no double date) (AC-3)', () => {
      expect(deriveDefaultOutputPath({ type: 'plan', prompt: 'Plan', paths: ['/x/2026-07-06-claims-demo.md'], today: TODAY }))
        .toBe('.mma/plans/2026-07-06-claims-demo.md');
    });

    it('strips the extension from the source basename', () => {
      expect(deriveDefaultOutputPath({ type: 'plan', prompt: 'Plan', paths: ['spec.markdown'], today: TODAY }))
        .toBe('.mma/plans/2026-07-11-spec.md');
    });

    it('inherits the first dated path even when an undated input precedes it', () => {
      expect(deriveDefaultOutputPath({ type: 'plan', prompt: 'Plan', paths: ['/scratch/notes.md', '/x/2026-07-06-claims-demo.md'], today: TODAY }))
        .toBe('.mma/plans/2026-07-06-claims-demo.md');
    });

    it('returns null for a plan with no source path (inline content — caller requires outputPath)', () => {
      expect(deriveDefaultOutputPath({ type: 'plan', prompt: 'Plan', today: TODAY })).toBeNull();
    });
  });

});
