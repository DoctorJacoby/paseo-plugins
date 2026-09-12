import { useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { BoxProjectListPayload, BoxProjectReportPayload } from "../shared/contracts.ts";
import { fontSize, leading, spacing, type Palette } from "./theme.ts";
import { Monospace, ReadingRow, type Reading } from "./status.tsx";
import { Button } from "./ui.tsx";

export const BOX_PROJECTS_QUERY_KEY = ["claude-tty", "box-projects"];

/** A project's configuration changes when somebody runs a command, not on its own. */
const REFETCH_MS = 60_000;

type Project = BoxProjectListPayload["projects"][number];

/**
 * Which of this host's projects a session can actually run in, and why not, for the ones where it
 * cannot.
 *
 * On a host that boxes its sessions, being configured is what makes a checkout workable at all: an
 * unregistered one resolves no box, and so gets no session, no credentials and no model. That
 * refusal arrives at spawn time, when somebody is already waiting for an agent. This is the same
 * answer, ahead of time, beside the projects it is about.
 *
 * It reads and never writes. Onboarding a project pauses for a token paste and deleting one throws
 * away a checkout, and neither belongs behind a button on a phone; the host's own `box-project new`
 * and `delete` stay the only way to do either, and the note below says so.
 */
export function BoxProjectSection({ palette }: { palette: Palette }) {
  const listProjects = useRpc(contracts.listBoxProjects);
  const query = useQuery({
    queryKey: BOX_PROJECTS_QUERY_KEY,
    queryFn: () => listProjects({}),
    refetchInterval: REFETCH_MS,
  });
  const payload = query.data ?? null;

  // A host with no box-project has no section: it is this machine's tool, and most machines this
  // plugin runs on have nothing to say here.
  if (payload === null || !payload.available) return null;

  return (
    <SettingsSection title="Projects on this host">
      {payload.problem === null ? (
        <SettingsCard>
          {payload.projects.length === 0 ? (
            <SettingsRow label="Paseo has no projects" hint="Nothing for box-project to say anything about" />
          ) : (
            payload.projects.map((project) => (
              <ProjectRow key={project.projectId} palette={palette} project={project} />
            ))
          )}
        </SettingsCard>
      ) : (
        <Monospace palette={palette} text={payload.problem} />
      )}

      <Text
        style={{
          color: palette.foregroundMuted,
          fontSize: fontSize.sm,
          lineHeight: leading(fontSize.sm),
          marginLeft: spacing[1],
        }}
      >
        A project with a box runs its sessions inside it, on the credentials its boundary lends. One
        marked `host:` is on the allowlist and runs out here on purpose. An unregistered one has no
        box, so a session in it is refused — `box-project new` is what onboards it, and it pauses for
        a token paste, so it stays a command on the host.
      </Text>
    </SettingsSection>
  );
}

/**
 * One project, with its check folded underneath. The check is per row rather than per section
 * because it is a round trip to the credential broker for that project's remote, and running every
 * project's on one button would be a dozen of them.
 */
function ProjectRow({ palette, project }: { palette: Palette; project: Project }) {
  const [report, setReport] = useState<BoxProjectReportPayload | null>(null);
  const checkProject = useRpc(contracts.checkBoxProject);
  const check = useMutation({
    mutationFn: () => checkProject({ name: nameForCheck(project) }),
    onSuccess: setReport,
  });

  return (
    <>
      <ReadingRow
        palette={palette}
        title={project.display}
        reading={projectReading(project)}
        trailing={
          project.state === "registered" ? (
            <Button
              palette={palette}
              label={check.isPending ? "Checking…" : "Check"}
              variant="ghost"
              disabled={check.isPending}
              onPress={() => check.mutate()}
            />
          ) : null
        }
      />
      {check.error ? <Monospace palette={palette} text={String(check.error)} /> : null}
      {report === null ? null : <Report palette={palette} report={report} />}
    </>
  );
}

function Report({ palette, report }: { palette: Palette; report: BoxProjectReportPayload }) {
  if (!report.ran) return <Monospace palette={palette} text={report.problem ?? "box-project said nothing"} />;
  return (
    <View style={{ gap: spacing[2] }}>
      {report.checks.map((item) => (
        <ReadingRow
          key={item.id}
          palette={palette}
          title={item.title}
          reading={{ hint: item.detail, tone: item.state === "fail" ? "danger" : item.state === "ok" ? "ok" : "muted" }}
        />
      ))}
    </View>
  );
}

/**
 * `box-project check` is keyed by the checkout's directory name, which is what the host's own files
 * name a project by — never Paseo's display name, which is whatever somebody typed.
 */
function nameForCheck(project: Project): string {
  const segments = project.path.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? project.path;
}

function projectReading(project: Project): Reading {
  if (project.state === "registered") {
    return { hint: project.boundary === null ? "In a box, in no boundary" : `In a box, ${project.boundary}`, tone: "ok" };
  }
  if (project.state === "host") return { hint: project.reason ?? "Runs on the host", tone: "muted" };
  return { hint: project.reason ?? "No box: a session here is refused", tone: "danger" };
}
