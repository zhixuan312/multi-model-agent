import { privacyFilter } from './privacy-filter.js';

export class TelemetryChannel {
  constructor(private uploader: { upload: (payload: unknown) => Promise<void> }) {}

  async emitTaskBundle(internal: Record<string, unknown>): Promise<void> {
    const filtered = privacyFilter(internal);
    const wire = this.toWire(filtered);
    await this.uploader.upload(wire);
  }

  private toWire(internal: Record<string, unknown>): Record<string, unknown> {
    return {
      ...internal,
      capabilities: [],
      clarificationRequested: false,
      briefQualityWarningCount: 0,
      triggeringSkill: null,
    };
  }
}
