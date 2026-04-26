import { describe, it, expect } from 'vitest';
import { firstRunNoticeText } from '../../packages/server/src/telemetry/notice.js';

describe('first-run notice (0.2.0 copy)', () => {
  it('matches §8.6 reference copy verbatim', () => {
    const expected = `multi-model-agent collects anonymous usage data to help improve the product.

  We collect:
    • An anonymous random ID, regenerated every 365 days
    • mmagent version, OS family, Node.js major version, language
    • Counts and bucketed durations/costs of tasks (no contents, no paths)
    • Routes used (delegate, audit, review, verify, debug, execute-plan)

  We never collect:
    • Your name, email, IP address, hostname, or username
    • File paths, project names, or repository information
    • Any content from your prompts, model output, code, or commits
    • Stack traces or raw error messages — only enum codes

  Full policy: https://github.com/zhixuan312/multi-model-agent/blob/main/PRIVACY.md

  To opt out:
    export MMAGENT_TELEMETRY=0
    # or in your config: telemetry.enabled = false
    # or run: mmagent telemetry disable
`;
    expect(firstRunNoticeText()).toBe(expected);
  });
});
