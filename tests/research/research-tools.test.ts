import { describe, expect, it } from 'vitest';
import { buildResearchTools } from '../../packages/core/src/runners/base/research-tools.js';
import { ResearchConfigSchema } from '../../packages/core/src/config/schema.js';

describe('buildResearchTools', () => {
  it('omits web_search when no Brave keys configured', () => {
    const cfg = ResearchConfigSchema.parse({});
    const t = buildResearchTools({ cfg, hostAllowlist: new Set(), privateNetworkHosts: new Set() });
    expect(t.web_search).toBeUndefined();
    expect(t.web_fetch).toBeDefined();
  });

  it('includes web_search when keys configured', () => {
    const cfg = ResearchConfigSchema.parse({ brave: { apiKeys: ['k1'] } });
    const t = buildResearchTools({ cfg, hostAllowlist: new Set(), privateNetworkHosts: new Set() });
    expect(t.web_search).toBeDefined();
  });

  it('omits adapters that are disabled', () => {
    const cfg = ResearchConfigSchema.parse({ builtinAdapters: { arxiv: false } });
    const t = buildResearchTools({ cfg, hostAllowlist: new Set(), privateNetworkHosts: new Set() });
    expect(t.arxiv).toBeUndefined();
    expect(t.semantic_scholar).toBeDefined();
  });

  it('arxiv tool rejects out-of-bound maxResults at the schema layer', async () => {
    const cfg = ResearchConfigSchema.parse({});
    const t = buildResearchTools({ cfg, hostAllowlist: new Set(), privateNetworkHosts: new Set() });
    const result = await t.arxiv!.handler({ query: 'test', maxResults: 999 });
    expect(result).toMatchObject({ ok: false, code: 'tool_input_invalid' });
  });

  it('web_fetch tool rejects empty URL', async () => {
    const cfg = ResearchConfigSchema.parse({});
    const t = buildResearchTools({ cfg, hostAllowlist: new Set(), privateNetworkHosts: new Set() });
    const result = await t.web_fetch.handler({ url: '' });
    expect(result).toMatchObject({ ok: false, code: 'tool_input_invalid' });
  });

  it('web_search tool rejects empty query', async () => {
    const cfg = ResearchConfigSchema.parse({ brave: { apiKeys: ['k1'] } });
    const t = buildResearchTools({ cfg, hostAllowlist: new Set(), privateNetworkHosts: new Set() });
    const result = await t.web_search!.handler({ query: '  ' });
    expect(result).toMatchObject({ ok: false, code: 'tool_input_invalid' });
  });

  it('all builtin adapters are enabled by default', () => {
    const cfg = ResearchConfigSchema.parse({});
    const t = buildResearchTools({ cfg, hostAllowlist: new Set(), privateNetworkHosts: new Set() });
    expect(t.arxiv).toBeDefined();
    expect(t.semantic_scholar).toBeDefined();
    expect(t.github_search).toBeDefined();
    expect(t.rss).toBeDefined();
  });

  it('web_search is omitted when brave keys array is empty', () => {
    const cfg = ResearchConfigSchema.parse({ brave: { apiKeys: [] } });
    const t = buildResearchTools({ cfg, hostAllowlist: new Set(), privateNetworkHosts: new Set() });
    expect(t.web_search).toBeUndefined();
  });

  it('github_search tool rejects invalid kind', async () => {
    const cfg = ResearchConfigSchema.parse({});
    const t = buildResearchTools({ cfg, hostAllowlist: new Set(), privateNetworkHosts: new Set() });

    const result = await t.github_search!.handler({ query: 'test', kind: 'invalid' });
    expect(result).toMatchObject({ ok: false, code: 'tool_input_invalid' });
  });

  it('rss tool rejects empty URL', async () => {
    const cfg = ResearchConfigSchema.parse({});
    const t = buildResearchTools({ cfg, hostAllowlist: new Set(), privateNetworkHosts: new Set() });

    const result = await t.rss!.handler({ url: '' });
    expect(result).toMatchObject({ ok: false, code: 'tool_input_invalid' });
  });

  it('each tool has required name/description/inputSchema/handler shape', () => {
    const cfg = ResearchConfigSchema.parse({ brave: { apiKeys: ['k1'] } });
    const t = buildResearchTools({ cfg, hostAllowlist: new Set(), privateNetworkHosts: new Set() });

    for (const tool of Object.values(t)) {
      expect(tool).toBeDefined();
      if (!tool) continue;
      expect(tool).toHaveProperty('name');
      expect(typeof tool.name).toBe('string');
      expect(tool).toHaveProperty('description');
      expect(typeof tool.description).toBe('string');
      expect(tool).toHaveProperty('inputSchema');
      expect(tool).toHaveProperty('handler');
      expect(typeof tool.handler).toBe('function');
    }
  });
});
