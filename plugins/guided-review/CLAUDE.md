# Working on this plugin

Run `paseo plugin reload guided-review` after every change, then `paseo plugin logs guided-review`.
The reload is the only compile check of the two bundles the daemon builds, so do it yourself rather than leaving it to the user.

## Orientation

- `server/review-service.ts` is the top level: each RPC in `shared/contracts.ts` is one of its methods, and `index.server.ts` only wires them.
  A new RPC goes in `shared/contracts.ts` and becomes a service method.
- The service reaches the outside only through ports: `server/forge/port.ts` (GitHub over `gh`, GitLab over `glab`), `server/workspaces/port.ts`, `server/guide-agent/port.ts`, and `server/command-runner.ts`, which every `gh`, `glab` and `git` call goes through.
  A new forge operation goes on the port first, then on each adapter.
- The fakes (`server/fake-*.ts`) sit beside the modules so every test shares them; keep them out of `index.server.ts`'s imports so they stay out of the bundle.
- `pnpm test` runs `node --test` with Node's type stripping: write only erasable TypeScript (no enums, namespaces or parameter properties) and keep the `.ts` extension on relative imports.

## Traps

### Paseo

- Paseo cuts a plugin RPC off after 30 seconds without stopping its handler.
  Anything that can take longer (reading a PR, cloning, creating a workspace, a guide agent's turn) runs as a background job the client polls.
- `paseo` arrives only on a handler's context; `index.server.ts` keeps the first one for jobs and hooks that outlive their RPC.
- `client.openPanel` throws until the app has the workspace cached, which a new workspace reaches a moment later: open panels through `openPanelWhenReady` in `client/open-panel.ts`.
- Import `@getpaseo/highlight` only on the server: its index pulls in every grammar.
  The client gets syntax tokens and colours over RPC.

### Guide agent

- Paseo passes an output schema only with an agent's first prompt, and only some providers enforce it.
  Send every structured request through `server/guide-agent/structured.ts`, which puts the schema in the prompt and validates the reply here.
- Sending to a busy agent interrupts its turn: check `status` before `run` or `send`.
- The permission hook denies every command `readOnlyCommand` (`server/guide-agent/read-only-command.ts`) does not recognise.
  A command you add to a prompt has to pass it, or the agent is denied it.
- The `git diff` options in `server/guide-prompt.ts` are pinned so the agent's hunks match the forge's patches, which `splitHunks` in `server/diff.ts` numbers (GitHub joins changes one line apart into one hunk, GitLab does not).
  Keep them matching the forge, whatever the host's git config says.

### GitHub

- GitHub refuses to edit a pending review's body while it is empty, which it is on every review started without one.
  The review body lives in `review-body.json` until submit and goes out only with the submit.
- Send GraphQL and JSON bodies on stdin with `--input -`: `gh api -F` turns a repository named `123` into a number.

### GitLab

- `glab` sends its token to any `--hostname` it is given.
  Check a host with `glab auth status --hostname` before the first call there, and pass `--hostname` on every call, since `glab` otherwise picks a host from the daemon's working directory.
- Address a project by its numeric ID: some GitLab versions refuse a URL-encoded path on the draft notes endpoints.
- Write draft notes as a JSON body on stdin with `--header 'Content-Type: application/json'`; without it GitLab reads a form and drops `position`.
- GitLab may store a draft's position other than the one sent, without an error, and a `PUT` replaces the position with whatever it is given.
  `createDraft` compares and deletes a misplaced draft, and `updateDraft` sends the stored position back.
- Read `glab api --paginate` with `--output ndjson` (`Cli.ndjson`): it prints each page as a separate JSON array.
- `glab auth status --all` exits 1 when any host fails; read it with `Cli.report`.
- Run `glab` with `PASEO_AGENT_ID` and `GITLAB_BOT_IDENTITY` unset (`GLAB_UNSET_ENV`), so a wrapper that switches to a bot account for agents still acts as the reviewer.

### Data

- Check-offs (`inbox-check-offs.json`) are kept apart from the list preferences (`inbox-preferences.json`) because the client saves preferences whole, which would overwrite a check-off sent around it.
- Build fixtures for calls that write (drafts, submits, discards) by hand from the API docs; recording them would publish to a real PR or MR.
- Record read fixtures under `server/forge/fixtures/` only from public PRs and MRs with read-only calls, then trim every user to its public fields, take out every email, and drop anything from a private repository, since they are committed.
