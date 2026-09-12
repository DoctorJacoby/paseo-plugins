import type { PaseoApi } from "@getpaseo/client";
import type {
  BoxProjectListPayload,
  BoxProjectReportPayload,
  DoctorPayload,
  RemoveStatePayload,
  SessionsPayload,
  StatusPayload,
} from "../shared/contracts.ts";
import { checkBoxProject, listBoxProjects } from "./box-project.ts";
import { lastDoctorReport, runDoctor } from "./doctor.ts";
import { listSessions, quarantineSession, releaseLock, releaseStaleLocks, stopSession } from "./sessions.ts";
import { removeState } from "./uninstall.ts";
import { readStatus } from "./status.ts";

export function statusHandler(paseo: PaseoApi): Promise<StatusPayload> {
  return readStatus(paseo);
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

export function lastDoctorHandler(): DoctorPayload | null {
  return lastDoctorReport();
}

export function releaseStaleLocksHandler(paseo: PaseoApi): Promise<SessionsPayload> {
  return releaseStaleLocks(paseo);
}

export function removeStateHandler(): Promise<RemoveStatePayload> {
  return removeState();
}

export function boxProjectListHandler(): Promise<BoxProjectListPayload> {
  return listBoxProjects();
}

export function boxProjectCheckHandler(input: { name: string }): Promise<BoxProjectReportPayload> {
  return checkBoxProject(input.name);
}
