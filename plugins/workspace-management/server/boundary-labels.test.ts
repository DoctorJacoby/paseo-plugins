import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundaryLabelManager,
  type LabelClient,
  type ManagedWorkspace,
  type WorkspaceLabelDefinition,
} from "./boundary-labels.ts";

class FakeLabelClient implements LabelClient {
  readonly assignments: Array<{ workspaceId: string; label: WorkspaceLabelDefinition; assigned: boolean }> = [];
  readonly updates: Array<{ name: string; color: WorkspaceLabelDefinition["color"] }> = [];
  readonly labels: WorkspaceLabelDefinition[];
  readonly workspaces: ManagedWorkspace[];

  constructor(labels: WorkspaceLabelDefinition[], workspaces: ManagedWorkspace[]) {
    this.labels = labels;
    this.workspaces = workspaces;
  }

  async listWorkspaceLabels() {
    return { labels: this.labels.map((label) => ({ ...label })) };
  }

  async setWorkspaceLabel(input: {
    workspaceId: string;
    label: WorkspaceLabelDefinition;
    assigned: boolean;
  }) {
    this.assignments.push(input);
    let definition = this.labels.find(
      (label) => label.name.toLowerCase() === input.label.name.toLowerCase(),
    );
    if (!definition && input.assigned) {
      definition = { ...input.label };
      this.labels.push(definition);
    }
    const workspace = this.workspaces.find((candidate) => candidate.id === input.workspaceId);
    if (workspace && input.assigned && definition) {
      workspace.labels ??= [];
      if (!workspace.labels.some((label) => label.toLowerCase() === definition?.name.toLowerCase())) {
        workspace.labels.push(definition.name);
      }
    }
    return { label: definition ?? input.label, workspaceLabels: workspace?.labels ?? [] };
  }

  async updateWorkspaceLabel(input: {
    name: string;
    color: WorkspaceLabelDefinition["color"];
  }) {
    this.updates.push(input);
    const label = this.labels.find(
      (candidate) => candidate.name.toLowerCase() === input.name.toLowerCase(),
    );
    assert.ok(label);
    label.color = input.color;
    return { label: { ...label } };
  }
}

const definitions = {
  "cebud-work": { name: "cebud-work", color: "orange" },
  "paseo-plugins": { name: "paseo-plugins", color: "sky" },
} as const;

/** The live set, `host` included: repairing the bad `host` sweep is what the repair pass is for. */
const withHost = { ...definitions, host: { name: "host", color: "red" } } as const;

function resolver(workspace: ManagedWorkspace): string | null {
  if (workspace.cwd.includes("remi-plus")) return "cebud-work";
  if (workspace.cwd.includes("paseo-plugins")) return "paseo-plugins";
  return null;
}

test("backfill creates missing definitions by assigning the first workspace", async () => {
  const workspaces: ManagedWorkspace[] = [
    { id: "one", projectId: "p1", cwd: "/work/remi-plus", labels: [] },
    { id: "two", projectId: "p2", cwd: "/work/paseo-plugins", labels: [] },
  ];
  const client = new FakeLabelClient([], workspaces);
  const manager = new BoundaryLabelManager({ client, definitions, resolveBoundary: resolver });

  await manager.backfill(workspaces);

  assert.deepEqual(client.labels, Object.values(definitions));
  assert.deepEqual(client.assignments, [
    { workspaceId: "one", label: definitions["cebud-work"], assigned: true },
    { workspaceId: "two", label: definitions["paseo-plugins"], assigned: true },
  ]);
});

test("backfill fixes committed colors and never removes a human label", async () => {
  const workspaces: ManagedWorkspace[] = [
    {
      id: "one",
      projectId: "p1",
      cwd: "/work/remi-plus",
      labels: ["manual", "cebud-work"],
    },
  ];
  const client = new FakeLabelClient([{ name: "cebud-work", color: "red" }], workspaces);
  const manager = new BoundaryLabelManager({ client, definitions, resolveBoundary: resolver });

  await manager.backfill(workspaces);

  assert.deepEqual(client.updates, [{ name: "cebud-work", color: "orange" }]);
  assert.deepEqual(client.assignments, []);
  assert.deepEqual(workspaces[0]?.labels, ["manual", "cebud-work"]);
});

test("running backfill twice is idempotent", async () => {
  const workspaces: ManagedWorkspace[] = [
    { id: "one", projectId: "p1", cwd: "/work/remi-plus", labels: [] },
  ];
  const client = new FakeLabelClient([], workspaces);
  const manager = new BoundaryLabelManager({ client, definitions, resolveBoundary: resolver });

  await manager.backfill(workspaces);
  await manager.backfill(workspaces);

  assert.equal(client.assignments.length, 1);
  assert.equal(client.updates.length, 0);
});

test("a newly created workspace gets its boundary label without disturbing existing ones", async () => {
  const workspace: ManagedWorkspace = {
    id: "new",
    projectId: "p1",
    cwd: "/work/remi-plus/new-worktree",
    labels: ["manual"],
  };
  const client = new FakeLabelClient([{ ...definitions["cebud-work"] }], [workspace]);
  const manager = new BoundaryLabelManager({ client, definitions, resolveBoundary: resolver });

  await manager.assign(workspace);

  assert.deepEqual(workspace.labels, ["manual", "cebud-work"]);
  assert.deepEqual(client.assignments, [
    { workspaceId: "new", label: definitions["cebud-work"], assigned: true },
  ]);
});

test("without a repair pass a wrong boundary label is left where it is", async () => {
  const workspace: ManagedWorkspace = {
    id: "one",
    projectId: "p1",
    cwd: "/work/remi-plus",
    labels: ["host"],
  };
  const client = new FakeLabelClient([{ name: "host", color: "red" }], [workspace]);
  const manager = new BoundaryLabelManager({
    client,
    definitions: withHost,
    resolveBoundary: resolver,
  });

  await manager.backfill([workspace]);

  assert.deepEqual(workspace.labels, ["host", "cebud-work"]);
  assert.deepEqual(
    client.assignments.map((entry) => [entry.label.name, entry.assigned]),
    [["cebud-work", true]],
  );
});

test("a repair pass takes off the managed label the host contradicts, and nothing else", async () => {
  const workspaces: ManagedWorkspace[] = [
    { id: "one", projectId: "p1", cwd: "/work/remi-plus", labels: ["host", "manual"] },
    { id: "two", projectId: "p2", cwd: "/work/paseo-plugins", labels: ["paseo-plugins"] },
  ];
  const client = new FakeLabelClient(
    [
      { name: "host", color: "red" },
      { name: "paseo-plugins", color: "sky" },
    ],
    workspaces,
  );
  const repairs: string[] = [];
  const manager = new BoundaryLabelManager({
    client,
    definitions: withHost,
    resolveBoundary: resolver,
    repair: true,
    onRepair: (message) => repairs.push(message),
  });

  await manager.backfill(workspaces);

  assert.deepEqual(workspaces[0]?.labels, ["manual", "cebud-work"]);
  assert.deepEqual(workspaces[1]?.labels, ["paseo-plugins"]);
  assert.deepEqual(
    client.assignments.map((entry) => [entry.workspaceId, entry.label.name, entry.assigned]),
    [
      ["one", "cebud-work", true],
      ["one", "host", false],
    ],
  );
  assert.equal(repairs.length, 1);
  assert.match(repairs[0] ?? "", /removed the "host" label/);
});

test("a repair pass removes nothing from a workspace whose boundary is unknown", async () => {
  const workspace: ManagedWorkspace = {
    id: "one",
    projectId: "p1",
    cwd: "/work/somewhere-else",
    labels: ["host", "cebud-work"],
  };
  const client = new FakeLabelClient([{ name: "host", color: "red" }], [workspace]);
  const manager = new BoundaryLabelManager({
    client,
    definitions: withHost,
    resolveBoundary: () => null,
    repair: true,
    onRepair: () => assert.fail("nothing is known about this workspace"),
  });

  await manager.backfill([workspace]);

  assert.deepEqual(workspace.labels, ["host", "cebud-work"]);
  assert.deepEqual(client.assignments, []);
});

test("an unconfigured or unknown boundary is left alone", async () => {
  const workspace: ManagedWorkspace = {
    id: "other",
    projectId: "p3",
    cwd: "/work/other",
    labels: ["manual"],
  };
  const client = new FakeLabelClient([], [workspace]);
  const manager = new BoundaryLabelManager({
    client,
    definitions,
    resolveBoundary: () => "not-managed",
  });

  await manager.assign(workspace);

  assert.deepEqual(client.assignments, []);
  assert.deepEqual(client.updates, []);
  assert.deepEqual(workspace.labels, ["manual"]);
});
