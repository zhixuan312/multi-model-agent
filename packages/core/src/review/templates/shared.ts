export interface ReviewTemplate {
  systemPrompt: string;
  buildUserPrompt(ctx: { workerOutput: string; brief: string; filesChanged?: string[] }): string;
}
