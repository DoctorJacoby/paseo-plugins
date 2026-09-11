import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const StatusSchema = z.object({
  /** The checkout this plugin was installed from, or null when it could not be identified. */
  repoRoot: z.string().nullable(),
  /** Why there is no checkout to manage; everything below is meaningless while this is set. */
  problem: z.string().nullable(),
  adapter: z.object({
    binary: z.string().nullable(),
    built: z.boolean(),
  }),
  host: z.object({
    node: z.string(),
    claude: z.string().nullable(),
  }),
  stateDirectory: z.string(),
  /** What the settings screen cannot see for itself: where the host keeps the document, and what overrides it. */
  settings: z.object({
    /** The document the host settings store owns, which is also the path the adapter is handed. */
    file: z.string(),
    /** Set when the daemon's environment pins the timeout, which the adapter honours over the setting. */
    envOverrideMs: z.number().int().nonnegative().nullable(),
  }),
  /** The adapter's entry in the daemon configuration from before this plugin owned the provider, or null. */
  legacyProvider: z
    .object({
      id: z.string(),
      configFile: z.string(),
      command: z.string(),
      /** Agents the daemon still lists on that entry, or null when it did not answer in time to count them all. */
      agents: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
});

export type StatusPayload = z.output<typeof StatusSchema>;

export const getStatus = defineRpc({
  name: "claude-tty.status",
  input: z.object({}),
  output: StatusSchema,
});

export const DiagnosticCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});

export const DoctorSchema = z.object({
  ranAt: z.number(),
  adapter: z.object({
    /** The executable this plugin hands the daemon as the provider's command. */
    binary: z.string().nullable(),
    ok: z.boolean(),
    problem: z.string().nullable(),
    checks: z.array(DiagnosticCheckSchema),
  }),
});

export type DoctorPayload = z.output<typeof DoctorSchema>;

export const runDoctor = defineRpc({
  name: "claude-tty.doctor.run",
  input: z.object({}),
  output: DoctorSchema,
});

export const getDoctor = defineRpc({
  name: "claude-tty.doctor.last",
  input: z.object({}),
  output: DoctorSchema.nullable(),
});

export const SessionSchema = z.object({
  id: z.string(),
  claudeSessionId: z.string().nullable(),
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  mode: z.string().nullable(),
  lastActivity: z.number().nullable(),
  corrupt: z.boolean(),
  orphanLock: z.boolean(),
  lock: z.object({ pid: z.number(), createdAt: z.number(), live: z.boolean() }).nullable(),
  /** The Paseo agent holding this session, when the daemon still lists one. */
  agent: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
});

export const SessionsSchema = z.object({
  stateDirectory: z.string(),
  problem: z.string().nullable(),
  /** The daemon's clock when it read the sessions; the panel may be on a machine with another. */
  now: z.number(),
  sessions: z.array(SessionSchema),
});

export type SessionsPayload = z.output<typeof SessionsSchema>;

export const getSessions = defineRpc({
  name: "claude-tty.sessions.list",
  input: z.object({}),
  output: SessionsSchema,
});

export const releaseLock = defineRpc({
  name: "claude-tty.locks.release",
  input: z.object({ id: z.string() }),
  output: SessionsSchema,
});

export const quarantineSession = defineRpc({
  name: "claude-tty.sessions.quarantine",
  input: z.object({ id: z.string() }),
  output: SessionsSchema,
});

export const stopSession = defineRpc({
  name: "claude-tty.sessions.stop",
  input: z.object({ id: z.string() }),
  output: SessionsSchema,
});

export const releaseStaleLocks = defineRpc({
  name: "claude-tty.locks.release-stale",
  input: z.object({}),
  output: SessionsSchema,
});

/** Removing the state directory either happens or throws, so what comes back is only what it did. */
export const RemoveStateSchema = z.object({ detail: z.string() });

export type RemoveStatePayload = z.output<typeof RemoveStateSchema>;

export const removeState = defineRpc({
  name: "claude-tty.state.remove",
  input: z.object({}),
  output: RemoveStateSchema,
});
