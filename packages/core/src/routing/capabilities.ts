import type { Capability, ProviderConfig } from '../types.js';

const FILE_CAPABILITIES: Capability[] = ['file_read', 'file_write', 'grep', 'glob'];

export function getBaseCapabilities(config: ProviderConfig): Capability[] {
  const caps: Capability[] = [...FILE_CAPABILITIES];

  if (config.sandboxPolicy === 'none') {
    caps.push('shell');
  }

  switch (config.type) {
    case 'codex': {
      const hosted = config.hostedTools ?? ['web_search'];
      if (hosted.includes('web_search')) caps.push('web_search');
      break;
    }
    case 'claude': {
      caps.push('web_search', 'web_fetch');
      break;
    }
    case 'openai-compatible': {
      if ((config.hostedTools ?? []).includes('web_search')) caps.push('web_search');
      break;
    }
  }

  return Array.from(new Set(caps));
}