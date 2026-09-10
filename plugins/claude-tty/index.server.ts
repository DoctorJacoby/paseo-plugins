import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as contracts from "./shared/contracts.ts";
import { claudeTtyProvider } from "./server/provider.ts";
import {
  doctorHandler,
  lastDoctorHandler,
  quarantineSessionHandler,
  readSubagentHandler,
  releaseLockHandler,
  releaseStaleLocksHandler,
  removeStateHandler,
  sessionsHandler,
  settingsHandler,
  statusHandler,
  stopSessionHandler,
  subagentsHandler,
} from "./server/handlers.ts";

export default function contribute(server: PluginServerContext) {
  // Registration has to be synchronous: the daemon reads the provider list out of the reply to its
  // initialize message, and connects the provider milliseconds later.
  server.registerProvider(claudeTtyProvider());

  server.handle(contracts.getStatus, () => statusHandler());
  server.handle(contracts.setSettings, (input) => settingsHandler(input));
  server.handle(contracts.runDoctor, () => doctorHandler());
  server.handle(contracts.getDoctor, () => lastDoctorHandler());
  server.handle(contracts.getSessions, (_input, { paseo }) => sessionsHandler(paseo));
  server.handle(contracts.releaseLock, (input, { paseo }) => releaseLockHandler(paseo, input));
  server.handle(contracts.quarantineSession, (input, { paseo }) => quarantineSessionHandler(paseo, input));
  server.handle(contracts.stopSession, (input, { paseo }) => stopSessionHandler(paseo, input));
  server.handle(contracts.getSubagents, () => subagentsHandler());
  server.handle(contracts.readSubagent, (input) => readSubagentHandler(input));
  server.handle(contracts.releaseStaleLocks, (_input, { paseo }) => releaseStaleLocksHandler(paseo));
  server.handle(contracts.removeState, () => removeStateHandler());

  return () => {};
}
