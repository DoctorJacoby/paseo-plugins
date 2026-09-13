import assert from "node:assert/strict";
import test from "node:test";
import type { BoundaryWorkspace } from "./boundary-config.ts";
import type { ManagedWorkspace, WorkspaceLabelDefinition } from "./boundary-labels.ts";
import { WorkspaceManagementService, type ManagementClient } from "./service.ts";

class FakeManagementClient implements ManagementClient {
  connected = false;
  closed = false;
  readonly assignments: string[] = [];
  readonly fetches: Array<{ filter?: { projectId?: string }; page?: { limit: number; cursor?: string } }> = [];
  readonly workspaces: ManagedWorkspace[] = [
    {
      id: "old-one",
      projectId: "project-one",
      cwd: "/boxes/old-one",
      projectRootPath: "/projects/one",
      labels: [],
    },
    {
      id: "old-two",
      projectId: "project-two",
      cwd: "/boxes/old-two",
      projectRootPath: "/projects/two",
      labels: [],
    },
    {
      id: "new-one",
      projectId: "project-one",
      cwd: "/boxes/new-one",
      projectRootPath: "/projects/one",
      labels: [],
    },
  ];

  async connect() {
    this.connected = true;
  }

  async close() {
    this.closed = true;
  }

  async fetchWorkspaces(options: {
    filter?: { projectId?: string };
    page?: { limit: number; cursor?: string };
  }) {
    this.fetches.push(options);
    const selected = options.filter?.projectId
      ? this.workspaces.filter((workspace) => workspace.projectId === options.filter?.projectId)
      : this.workspaces.filter((workspace) => workspace.id.startsWith("old"));
    if (options.filter?.projectId) {
      return { entries: selected, pageInfo: { nextCursor: null } };
    }
    return options.page?.cursor
      ? { entries: selected.slice(1), pageInfo: { nextCursor: null } }
      : { entries: selected.slice(0, 1), pageInfo: { nextCursor: "second" } };
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
  return workspace.projectRootPath === "/projects/one" ? "zone" : null;
}

test("plugin start connects, paginates active workspaces, and backfills them", async () => {
  const client = new FakeManagementClient();
  const service = new WorkspaceManagementService({
    client,
    definitions,
    loadResolver: async () => resolve,
  });

  await service.start();

  assert.equal(client.connected, true);
  assert.deepEqual(client.assignments, ["old-one"]);
  assert.deepEqual(
    client.fetches.map((entry) => entry.page?.cursor ?? null),
    [null, "second"],
  );
});

test("the creation hook resolves against the workspace project root", async () => {
  const client = new FakeManagementClient();
  const service = new WorkspaceManagementService({
    client,
    definitions,
    loadResolver: async () => resolve,
  });
  await service.start();
  client.assignments.length = 0;
  client.fetches.length = 0;

  await service.workspaceCreated({
    id: "new-one",
    projectId: "project-one",
    cwd: "/boxes/new-one",
  });

  assert.deepEqual(client.assignments, ["new-one"]);
  assert.equal(client.fetches[0]?.filter?.projectId, "project-one");
});

test("stop closes the plugin-owned daemon connection", async () => {
  const client = new FakeManagementClient();
  const service = new WorkspaceManagementService({
    client,
    definitions,
    loadResolver: async () => resolve,
  });
  await service.start();

  await service.stop();

  assert.equal(client.closed, true);
});
