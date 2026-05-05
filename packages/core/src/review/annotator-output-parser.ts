export interface ParsedAnnotatorOutput {
  verdict: 'annotated' | 'error';
  annotatedText: string;
}

export class AnnotatorOutputParser {
  parse(opts: { finalAssistantText: string | undefined; errorCode: string | undefined }): ParsedAnnotatorOutput {
    return {
      verdict: opts.errorCode ? 'error' : 'annotated',
      annotatedText: opts.finalAssistantText ?? '',
    };
  }
}
