export interface ReworkPromptContext {
  brief?: string;
  priorConcerns?: string[];
}

export function reworkPrompt(ctx: ReworkPromptContext): string {
  const parts: string[] = [];
  if (ctx.priorConcerns && ctx.priorConcerns.length > 0) {
    parts.push(
      `# Reviewer deviations to fix\n${ctx.priorConcerns
        .map((c, i) => `${i + 1}. ${c}`)
        .join('\n')}`,
    );
  } else {
    parts.push('# Reviewer deviations to fix\n(none — should not have reached this stage; end immediately)');
  }
  parts.push(
    '# Action\n' +
    '1. Fix each deviation in order.\n' +
    '2. Apply one edit call per file. Do not re-read after editing.\n' +
    '3. Write your summary and end your turn.\n' +
    '4. In your final WorkerOutput JSON: set workerStatus to "done" if your "Could not fix" line is empty (every listed deviation was addressed). Reserve "failed" / "blocked" for deviations you could not address — having had concerns to begin with is not, in itself, a concern.',
  );
  return parts.join('\n\n');
}
