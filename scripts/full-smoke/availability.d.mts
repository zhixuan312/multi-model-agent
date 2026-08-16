export interface AvailabilityProbeOptions {
  token?: string;
  intervalMs?: number;
  baseUrl?: string;
  failMs?: number;
}

export interface AvailabilityProbeResult {
  status: 'PASS' | 'WARN' | 'FAIL' | 'NA';
  probes: number;
  failures: number;
  slowestMs: number;
  longestOutageMs: number;
  outages: number[];
  detail: string;
}

export interface AvailabilityProbe {
  stop(): Promise<AvailabilityProbeResult>;
}

export function startAvailabilityProbe(options?: AvailabilityProbeOptions): AvailabilityProbe;
