import fs from 'fs/promises';

const PLAN_CONTEXT_MAX_CHARS = 10_000;

export async function extractPlanSection(
  planFilePaths: string[],
  taskDescriptor: string,
  cwd: string | undefined,
): Promise<string | undefined> {
  const basePath = cwd ?? process.cwd();

  for (const filePath of planFilePaths) {
    try {
      const resolved = filePath.startsWith('/') ? filePath : `${basePath}/${filePath}`;
      const content = await fs.readFile(resolved, 'utf-8');

      const lines = content.split('\n');
      let startIndex = -1;
      let headingLevel = 0;

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(#{1,6})\s+(.*)/);
        if (match && match[2].trim() === taskDescriptor.trim()) {
          startIndex = i;
          headingLevel = match[1].length;
          break;
        }
      }

      if (startIndex === -1) continue;

      let endIndex = lines.length;
      for (let i = startIndex + 1; i < lines.length; i++) {
        const match = lines[i].match(/^(#{1,6})\s/);
        if (match && match[1].length <= headingLevel) {
          endIndex = i;
          break;
        }
      }

      let section = lines.slice(startIndex, endIndex).join('\n');
      if (section.length > PLAN_CONTEXT_MAX_CHARS) {
        section = section.slice(0, PLAN_CONTEXT_MAX_CHARS) + '\n[truncated at 10KB]';
      }
      return section;
    } catch {
      if (process.env.MULTI_MODEL_DEBUG === '1') {
        console.error(`[multi-model-agent] plan file not readable: ${filePath}`);
      }
    }
  }

  return undefined;
}
