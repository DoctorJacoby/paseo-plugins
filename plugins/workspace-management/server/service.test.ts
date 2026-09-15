import assert from "node:assert/strict";
import test from "node:test";
import type { BoundaryWorkspace } from "./boundary-config.ts";
import type { ManagedWorkspace, WorkspaceLabelDefinition } from "./boundary-labels.ts";
import { WorkspaceManagementService, type ManagementClient } from "./service.ts";

class FakeManagementClient implements ManagementClient {
  listCalls = 0;
  readonly assignments: string[] = [];
  readonly operations: Array<{ workspaceId: string; name: string; assigned: boolean }> = [];
  readonly workspaces: ManagedWorkspace[] = [
    { id: "open-one", projectId: "project-one", cwd: "/boxes/one", labels: [] },
    { id: "open-two", projectId: "project-two", cwd: "/elsewhere/two", labels: [] },
  ];

  async listWorkspaces(): Promise<ManagedWorkspace[]> {
    this.listCalls += 1;
    return this.workspaces.map((workspace) => ({ ...workspace }));
  }

  async listWorkspaceLabels() {
    return { labels: [] as WorkspaceLabelDefinition[] };
  }

  async setWorkspaceLabel(input: {
    workspaceId: string;
    label: WorkspaceLabelDefinition;
    assigned: boolean;
  }) {
    this.assignments.push(input.workspaceId);
    this.operations.push({
      workspaceId: input.workspaceId,
      name: input.label.name,
      assigned: input.assigned,
    });
    return {};
  }

  async updateWorkspaceLabel() {
    return {};
  }
}

const definitions = {
  zone: { name: "zone", color: "sky" },
} as const;

function resolve(workspace: BoundaryWorkspace): string | null {
  return workspace.cwd.startsWith("/boxes/") ? "zone" : null;
}

function service(loads: { count: number } = { count: 0 }) {
  return new WorkspaceManagementService({
    definitions,
    loadResolver: async () => {
      loads.count += 1;
      return resolve;
    },
  });
}

test("the first workspace event backfills every open workspace", async () => {
  const client = new FakeManagementClient();

  await service().workspaceCreated(client, {
    id: "new-one",
    projectId: "project-one",
    cwd: "/boxes/new-one",
  });

  assert.equal(client.listCalls, 1);
  assert.deepEqual(client.assignments, ["open-one", "new-one"]);
});

test("later events label only the workspace that was created", async () => {
  const client = new FakeManagementClient();
  const managed = service();

  await managed.workspaceCreated(client, {
    id: "new-one",
    projectId: "project-one",
    cwd: "/boxes/new-one",
  });
  client.assignments.length = 0;

  await managed.workspaceCreated(client, {
    id: "new-two",
    projectId: "project-one",
    cwd: "/boxes/new-two",
  });

  assert.equal(client.listCalls, 1);
  assert.deepEqual(client.assignments, ["new-two"]);
});

test("a workspace the daemon has not listed yet is still labeled", async () => {
  const client = new FakeManagementClient();

  await service().workspaceCreated(client, {
    id: "unlisted",
    projectId: "project-one",
    cwd: "/boxes/unlisted",
  });

  assert.ok(client.assignments.includes("unlisted"));
});

test("the host maps are re-read on every event", async () => {
  const client = new FakeManagementClient();
  const loads = { count: 0 };
  const managed = service(loads);

  await managed.workspaceCreated(client, { id: "a", projectId: "p", cwd: "/boxes/a" });
  await managed.workspaceCreated(client, { id: "b", projectId: "p", cwd: "/boxes/b" });

  assert.equal(loads.count, 2);
});

test("a workspace outside every configured boundary is left unlabeled", async () => {
  const client = new FakeManagementClient();

  await service().workspaceCreated(client, {
    id: "outside",
    projectId: "project-two",
    cwd: "/elsewhere/outside",
  });

  assert.equal(client.assignments.includes("outside"), false);
});

test("a repairing service passes the repair through to reconciliation", async () => {
  const client = new FakeManagementClient();
  client.workspaces[0]!.labels = ["host"];
  const repairing = new WorkspaceManagementService({
    definitions: { ...definitions, host: { name: "host", color: "red" } },
    loadResolver: async () => resolve,
    repair: true,
  });

  await repairing.workspaceCreated(client, {
    id: "open-one",
    projectId: "project-one",
    cwd: "/boxes/one",
  });

  assert.deepEqual(client.operations, [
    { workspaceId: "open-one", name: "zone", assigned: true },
    { workspaceId: "open-one", name: "host", assigned: false },
  ]);
});

test("the default service repairs nothing", async () => {
  const client = new FakeManagementClient();
  client.workspaces[0]!.labels = ["host"];

  await service().workspaceCreated(client, {
    id: "open-one",
    projectId: "project-one",
    cwd: "/boxes/one",
  });

  assert.deepEqual(
    client.operations.filter((operation) => !operation.assigned),
    [],
  );
});
