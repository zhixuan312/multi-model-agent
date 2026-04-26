import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildInstallMeta } from '../../packages/server/src/telemetry/install-meta.js';

const orig = Date.prototype.getTimezoneOffset;
afterEach(() => { Date.prototype.getTimezoneOffset = orig; });

function withTzOffsetMinutes(min: number, fn: () => void) {
  Date.prototype.getTimezoneOffset = () => min;
  try { fn(); } finally { Date.prototype.getTimezoneOffset = orig; }
}

describe('install-meta builder', () => {
  it('builds os/nodeMajor/language/tzOffsetBucket from current process', () => {
    const meta = buildInstallMeta({
      installId: '11111111-1111-4111-8111-111111111111',
      mmagentVersion: '3.6.0',
    });
    expect(meta.os).toMatch(/^(darwin|linux|win32|other)$/);
    expect(meta.nodeMajor).toMatch(/^[1-9]\d?$/);
    expect(meta.language).toMatch(/^[a-z]{2}|other$/);
    expect(meta.tzOffsetBucket).toMatch(/^utc_/);
    expect(meta.installId).toBe('11111111-1111-4111-8111-111111111111');
    expect(meta.mmagentVersion).toBe('3.6.0');
  });

  describe('language bucketing', () => {
    it('en-US → en', () => {
      const saved = process.env.LANG;
      process.env.LANG = 'en_US.UTF-8';
      try {
        expect(buildInstallMeta({
          installId: 'a'.repeat(36),
          mmagentVersion: '0.0.0',
        }).language).toBe('en');
      } finally {
        process.env.LANG = saved;
      }
    });

    it('zh-CN → zh', () => {
      const saved = process.env.LANG;
      process.env.LANG = 'zh_CN.UTF-8';
      try {
        expect(buildInstallMeta({
          installId: 'a'.repeat(36),
          mmagentVersion: '0.0.0',
        }).language).toBe('zh');
      } finally {
        process.env.LANG = saved;
      }
    });

    it('xx-YY → other (unrecognized)', () => {
      const saved = process.env.LANG;
      process.env.LANG = 'xx_YY.UTF-8';
      try {
        expect(buildInstallMeta({
          installId: 'a'.repeat(36),
          mmagentVersion: '0.0.0',
        }).language).toBe('other');
      } finally {
        process.env.LANG = saved;
      }
    });
  });

  describe('tzOffsetBucket', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('UTC-12 → utc_minus_12_to_minus_6', () => {
      vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(720);
      expect(buildInstallMeta({
        installId: 'a'.repeat(36),
        mmagentVersion: '0.0.0',
      }).tzOffsetBucket).toBe('utc_minus_12_to_minus_6');
    });

    it('UTC-5 → utc_minus_6_to_0', () => {
      vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(300);
      expect(buildInstallMeta({
        installId: 'a'.repeat(36),
        mmagentVersion: '0.0.0',
      }).tzOffsetBucket).toBe('utc_minus_6_to_0');
    });

    it('UTC+0 → utc_0_to_plus_6', () => {
      vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(0);
      expect(buildInstallMeta({
        installId: 'a'.repeat(36),
        mmagentVersion: '0.0.0',
      }).tzOffsetBucket).toBe('utc_0_to_plus_6');
    });

    it('UTC+8 → utc_plus_6_to_plus_12', () => {
      vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480);
      expect(buildInstallMeta({
        installId: 'a'.repeat(36),
        mmagentVersion: '0.0.0',
      }).tzOffsetBucket).toBe('utc_plus_6_to_plus_12');
    });

    it('UTC+13 → utc_plus_12_to_plus_15', () => {
      vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-780);
      expect(buildInstallMeta({
        installId: 'a'.repeat(36),
        mmagentVersion: '0.0.0',
      }).tzOffsetBucket).toBe('utc_plus_12_to_plus_15');
    });

    it('UTC+14 → utc_plus_12_to_plus_15 (upper bound)', () => {
      vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-840);
      expect(buildInstallMeta({
        installId: 'a'.repeat(36),
        mmagentVersion: '0.0.0',
      }).tzOffsetBucket).toBe('utc_plus_12_to_plus_15');
    });

    it('UTC-15 (out-of-range low) → utc_minus_12_to_minus_6 (safe bucket)', () => {
      vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(900);
      expect(buildInstallMeta({
        installId: 'a'.repeat(36),
        mmagentVersion: '0.0.0',
      }).tzOffsetBucket).toBe('utc_minus_12_to_minus_6');
    });

    it('UTC+15 (out-of-range high) → utc_plus_12_to_plus_15 (safe bucket)', () => {
      vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-900);
      expect(buildInstallMeta({
        installId: 'a'.repeat(36),
        mmagentVersion: '0.0.0',
      }).tzOffsetBucket).toBe('utc_plus_12_to_plus_15');
    });

    it('UTC-6 maps to utc_minus_6_to_0 (half-open contract)', () => {
      withTzOffsetMinutes(360, () => {
        const meta = buildInstallMeta({ installId: '11111111-1111-4111-8111-111111111111', mmagentVersion: '0.2.0' });
        expect(meta.tzOffsetBucket).toBe('utc_minus_6_to_0');
      });
    });

    it('UTC-7 still maps to utc_minus_12_to_minus_6', () => {
      withTzOffsetMinutes(420, () => {
        const meta = buildInstallMeta({ installId: '11111111-1111-4111-8111-111111111111', mmagentVersion: '0.2.0' });
        expect(meta.tzOffsetBucket).toBe('utc_minus_12_to_minus_6');
      });
    });

    it('UTC+0 maps to utc_0_to_plus_6', () => {
      withTzOffsetMinutes(0, () => {
        const meta = buildInstallMeta({ installId: '11111111-1111-4111-8111-111111111111', mmagentVersion: '0.2.0' });
        expect(meta.tzOffsetBucket).toBe('utc_0_to_plus_6');
      });
    });
  });
});
