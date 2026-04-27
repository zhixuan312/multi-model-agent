import type { RunStatus } from '../runners/types.js';
import type { AgentType } from '../types.js';

export type ShutdownCause =
  | 'stdin_end'
  | 'stdout_epipe'
  | 'stdout_other_error'
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'SIGTERM'
  | 'SIGINT'
  | 'SIGPIPE'
  | 'SIGHUP'
  | 'SIGABRT'
  | 'event_loop_empty'
  | 'SIGTERM_drain_timeout';

export type SessionCloseReason = 'client_closed' | 'transport_error' | 'session_expired' | 'daemon_shutdown' | 'handshake_failed';

export type EventPrimitive = string | number | boolean | null;
export interface TaskEvent { event: string; batchId: string; taskIndex: number; [key: string]: EventPrimitive | undefined; }

export type DiagLoop = 'spec' | 'quality' | 'diff';
export type DiagRole = 'implementer' | 'specReviewer' | 'qualityReviewer' | 'diffReviewer';
export type DiagReason = 'transport_failure' | 'not_configured';

export interface EscalationEventParams {
  batchId: string;
  taskIndex: number;
  loop: DiagLoop;
  attempt: number;
  baseTier: AgentType;
  implTier: AgentType;
  reviewerTier: AgentType;
}

export interface EscalationUnavailableEventParams {
  batchId: string;
  taskIndex: number;
  loop: DiagLoop;
  attempt: number;
  role: DiagRole;
  wantedTier: AgentType;
  reason: DiagReason;
}

export interface FallbackEventParams {
  batchId: string;
  taskIndex: number;
  loop: DiagLoop;
  attempt: number;
  role: DiagRole;
  assignedTier: AgentType;
  usedTier: AgentType;
  reason: DiagReason;
  triggeringStatus?: RunStatus;
  violatesSeparation: boolean;
}

export interface FallbackUnavailableEventParams {
  batchId: string;
  taskIndex: number;
  loop: DiagLoop;
  attempt: number;
  role: DiagRole;
  assignedTier: AgentType;
  reason: DiagReason;
}
