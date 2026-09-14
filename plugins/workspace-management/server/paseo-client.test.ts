import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { PaseoManagementClient, requireLabelApi } from "./paseo-client.ts";

interface Call {
  method: string;
  args: unknown[];
}

function fakePaseo(input: {
  labels?: boolean;
  pages?: Array<{ entries: unknown[]; pageInfo: { nextCursor: string | null } }>;
  calls?: Call[];
}): PaseoApi {
  const calls = input.calls ?? [];
  const pages = input.pages ?? [{ entries: [], pageInfo: { nextCursor: null } }];
  let page = 0;
  const workspaces: Record<string, unknown> = {
    list: async (options: unknown) => {
      calls.push({ method: "list", args: [options] });
      return pages[Math.min(page++, pages.length - 1)];
    },
  };
  if (input.labels !== false) {
    workspaces.labels = {
      list: async () => {
        calls.push({ method: "labels.list", args: [] });
        return { labels: [{ name: "zone", color: "sky" }] };
      },
      set: async (...args: unknown[]) => {
        calls.push({ method: "labels.set", args });
        return {};
      },
      update: async (...args: unknown[]) => {
        calls.push({ method: "labels.update", args });
        return {};
      },
    };
  }
  return { workspaces } as unknown as PaseoApi;
}

test("a daemon without the label API is refused with one clear sentence", () => {
  assert.throws(() => requireLabelApi(fakePaseo({ labels: false })), /no workspace labels/);
});

test("label reads and writes go through the injected API", async () => {
  const calls: Call[] = [];
  const client = new PaseoManagementClient(fakePaseo({ calls }));

  assert.deepEqual(await client.listWorkspaceLabels(), {
    labels: [{ name: "zone", color: "sky" }],
  });
  await client.setWorkspaceLabel({
    workspaceId: "wks_1",
    label: { name: "zone", color: "sky" },
    assigned: true,
  });
  await client.updateWorkspaceLabel({ name: "zone", color: "emerald" });

  assert.deepEqual(calls, [
    { method: "labels.list", args: [] },
    { method: "labels.set", args: ["wks_1", { name: "zone", color: "sky" }, true] },
    { method: "labels.update", args: [{ name: "zone", color: "emerald" }] },
  ]);
});

test("the workspace directory is read to the last page", async () => {
  const calls: Call[] = [];
  const client = new PaseoManagementClient(
    fakePaseo({
      calls,
      pages: [
        {
          entries: [
            {
              id: "wks_1",
              projectId: "project",
              workspaceDirectory: "/boxes/one",
              projectRootPath: "/projects/one",
              labels: ["kept"],
            },
          ],
          pageInfo: { nextCursor: "page-2" },
        },
        {
          entries: [
            {
              id: "wks_2",
              projectId: "project",
              projectRootPath: "/projects/two",
            },
          ],
          pageInfo: { nextCursor: null },
        },
      ],
    }),
  );

  assert.deepEqual(await client.listWorkspaces(), [
    {
      id: "wks_1",
      projectId: "project",
      cwd: "/boxes/one",
      projectRootPath: "/projects/one",
      labels: ["kept"],
    },
    {
      id: "wks_2",
      projectId: "project",
      cwd: "/projects/two",
      projectRootPath: "/projects/two",
      labels: [],
    },
  ]);
  assert.deepEqual(
    calls.map((call) => call.args[0]),
    [{ page: { limit: 200 } }, { page: { limit: 200, cursor: "page-2" } }],
  );
});
