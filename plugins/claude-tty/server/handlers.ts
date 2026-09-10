import type { PaseoApi } from "@getpaseo/client";
import type {
  DoctorPayload,
  RemoveStatePayload,
  SessionsPayload,
  StatusPayload,
  SubagentsPayload,
  SubagentTranscriptPayload,
} from "../shared/contracts.ts";
import { lastDoctorReport, runDoctor } from "./doctor.ts";
import { listSessions, quarantineSession, releaseLock, releaseStaleLocks, stopSession } from "./sessions.ts";
import { listSubagents, readSubagentTranscript } from "./subagents.ts";
import { removeState } from "./uninstall.ts";
import { readStatus } from "./status.ts";
import { updateSettings } from "./settings.ts";

export function statusHandler(): Promise<StatusPayload> {
  return readStatus();
}

export function settingsHandler(input: { idleTimeoutMs: number }): Promise<StatusPayload> {
  return updateSettings(input.idleTimeoutMs);
}

export function doctorHandler(): Promise<DoctorPayload> {
  return runDoctor();
}

export function sessionsHandler(paseo: PaseoApi): Promise<SessionsPayload> {
  return listSessions(paseo);
}

export function releaseLockHandler(paseo: PaseoApi, input: { id: string }): Promise<SessionsPayload> {
  return releaseLock(paseo, input.id);
}

export function quarantineSessionHandler(paseo: PaseoApi, input: { id: string }): Promise<SessionsPayload> {
  return quarantineSession(paseo, input.id);
}

export function stopSessionHandler(paseo: PaseoApi, input: { id: string }): Promise<SessionsPayload> {
  return stopSession(paseo, input.id);
}

export function subagentsHandler(): Promise<SubagentsPayload> {
  return listSubagents();
}

export function readSubagentHandler(input: { sessionId: string; agentId: string }): Promise<SubagentTranscriptPayload> {
  return readSubagentTranscript(input.sessionId, input.agentId);
}

export function lastDoctorHandler(): DoctorPayload | null {
  return lastDoctorReport();
}

export function releaseStaleLocksHandler(paseo: PaseoApi): Promise<SessionsPayload> {
  return releaseStaleLocks(paseo);
}

export function removeStateHandler(): Promise<RemoveStatePayload> {
  return removeState();
}
