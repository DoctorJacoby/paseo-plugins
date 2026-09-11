import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as contracts from "./shared/contracts.ts";
import { settingsDocument } from "./shared/settings.ts";
import { claudeTtyProvider } from "./server/provider.ts";
import { carryOverIdleTimeout } from "./server/upgrade.ts";
import {
  doctorHandler,
  lastDoctorHandler,
  quarantineSessionHandler,
  readSubagentHandler,
  releaseLockHandler,
  releaseStaleLocksHandler,
  removeStateHandler,
  sessionsHandler,
  statusHandler,
  stopSessionHandler,
  subagentsHandler,
} from "./server/handlers.ts";

export default function contribute(server: PluginServerContext) {
  // Registration has to be synchronous: the daemon reads the provider list out of the reply to its
  // initialize message, and connects the provider milliseconds later.
  server.registerProvider(claudeTtyProvider());

  // The store this registers is the settings screen's whole backing; the plugin only reads the path
  // it writes to, and hands that to the adapter.
  server.registerSettings(settingsDocument);

  // An install from before the host owned the settings kept the idle timeout in a file of its own.
  void carryOverIdleTimeout();

  server.handle(contracts.getStatus, (_input, { paseo }) => statusHandler(paseo));
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
