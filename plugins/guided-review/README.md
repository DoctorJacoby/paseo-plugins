# Guided Review

Read a GitHub pull request or GitLab merge request as a guide that starts from the foundations, and build your draft review alongside it.
Each review gets its own Paseo workspace, checked out at the change, with a **Guided Review** panel in it.

## Installation

Requires:

- Paseo 0.11 or newer
- `pnpm` on the daemon's `PATH`
- Either or both:
  - [`gh`](https://cli.github.com/), logged in with `gh auth login`, to review pull requests on github.com; GitHub Enterprise is not supported
  - [`glab`](https://gitlab.com/gitlab-org/cli), logged in with `glab auth login`, to review GitLab merge requests on gitlab.com or a self-hosted GitLab

```sh
paseo plugin add github:sleeyax/paseo-plugins:plugins/guided-review
```

Update with `paseo plugin update guided-review`.
To install from source, see the [root README](../../README.md#from-source).

## Usage

### Start a review

1. Select **Guided Review** in the sidebar.
2. Select **New review** and paste a pull request or merge request URL, or several, one per line.
3. Select **Start review**, or press Ctrl+Enter (Cmd+Enter on a Mac).

The plugin prepares a workspace for each review and has a guide agent write the guide there.
The workspace belongs to the Paseo project whose `origin` is the repository under review.
When you have none, the plugin clones the repository once into `$PASEO_HOME/plugin-data/guided-review/clones/`, which then shows up as a Paseo project of its own.
Nothing opens on its own, so you can start several and read them once they are ready.
Select **Open** when a review is ready.

To guide the branch you already have checked out, choose **Guided Review: guide this branch's PR/MR** in the Command Center, or select **Guide this branch's PR/MR** in an empty **Guided Review** panel.
If your branch is clean and behind the PR/MR, the plugin fast-forwards it and writes the guide in your workspace.
Otherwise it leaves your branch alone and uses a new workspace.

### Pick from your review requests or your own

The start tab lists open pull requests and merge requests in two tabs.
**Assigned to me** lists the ones you are a reviewer of, on github.com and on every GitLab host `glab` is logged in to.
**Authored by me** lists your own on the same hosts, drafts included.
Its review status combines your reviewers' latest verdicts, and changes requested by any reviewer outweigh approvals.
An approval GitLab removes, or GitHub dismisses, when you push shows as an approval reset.
On GitLab, an approval its reviewer revokes shows as an approval reset too.
A merge request you wrote and review is on both tabs, with the one review you started from either.

- Select **Review** to start a review, **Open** to open one, or **Continue** to reopen one whose workspace was closed.
- Filter by forge, by state under **States**, with **Needs my attention** or with **Hide drafts**, or search.
  On **Authored by me**, the search also matches reviewers.
  On **Authored by me**, **Needs my attention** keeps changes requested, a review since your last push, and failing CI.
- Select a column heading to sort, and **Columns** to choose what the table shows.
- Each tab keeps its own filters, sort, columns and search.
- Tick a row's box to check it off while it waits on someone else.
  On **Assigned to me**, it comes back when someone pushes to it, asks you to review again, or GitLab resets your approval.
  On **Authored by me**, it comes back when a reviewer reviews again or its review status changes, an approval reset included, but not when you push.
  A check-off on one tab leaves the other tab alone.
- Select **Refresh** to list both tabs again.

The count beside **Guided Review** in the sidebar is how many review requests on **Assigned to me** need your attention.

If a review workspace shows no panel, select **Open Guided Review** in the workspace's header.

### Read the guide

A new review opens on the PR/MR's **Description**.
The guide follows with an **Overview**: the idea behind the change, the author's decisions, and where to spend your attention.
Then come the concepts of the change in layers, foundations first, each with the code it covers.
Tests, documentation, supporting changes, and anything the guide did not place are listed after the layers, so every changed line shows up somewhere.

- Select **Mark understood** on a concept or file once you have read it, or **Understood → next** at the bottom to move on.
- Select **Mark all understood** on a group to skip it in one go.
- Select **Ask about this** to ask the guide agent a question; its chat opens with your question.

The panel picks up where you left off, also after a restart.

### When the PR/MR changes

When someone pushes new commits, the panel shows **PR updated since this guide** (**MR updated** on GitLab).
The guide does not change on its own.
Select **Regenerate** to guide the new head; concepts you marked understood stay marked where their code did not change.

When the PR/MR carries commits from another PR/MR, a warning says so above the guide.
Select **Fix** to see which, ask the author to retarget, or choose whether to guide the **Whole diff** or its **Own work only**.

### Comment

- Tap a line in any diff to comment on it, or drag across lines for a range.
  On a touch screen, hold the first line before dragging.
- Select **Comment on file** in a file's header.
- Select **Comment on this concept**, or highlight text in the guide, to comment on the change as a whole.
  In the phone app, hold a paragraph instead.

Type a rough thought, or nothing, and select **Suggest wording** to have the guide agent write the comment for you.
Select **Ask agent** instead of saving to ask the guide agent about the lines rather than comment on them.

**Save draft** puts the comment on the forge as a draft right away.
Nobody sees it until you finish the review.
**Your drafts** lists them, including drafts you started on the web.

On GitHub, comments on a concept or on highlighted text are the exception: they stay on your machine until you finish the review, and are then posted as separate comments on the pull request, before the review itself.
On GitLab they are draft notes on the merge request as a whole, like any other draft.

### Finish the review

Select **Finish review**, write the review body, and choose **Approve**, **Request changes**, or **Comment**.
If commits were pushed since the guide was written, a warning says so before you submit.
After a submit, the panel lists each step and whether it went through.
On GitHub your review stays on the commit the guide explained, so a repository that dismisses stale approvals may not count an approval when commits were pushed since.

**Discard review** deletes your drafts and the body.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| gh path | `gh` | The `gh` the daemon runs: a command on its `PATH` or an absolute path. |
| glab path | `glab` | The `glab` the daemon runs, the same way. |
| Provider and model | `claude-tty` | The agent that writes guides: a provider, or `provider/model` like `codex/gpt-5.5`. Falls back to `claude` when the [claude-tty](../claude-tty) provider is not available. |
| Effort | _blank_ | The model's effort level, like `high`. Blank uses the model's default. |
| Mode | _blank_ | The guide agent's mode. Blank uses the provider's plan or read-only mode. Only modes that ask before running a tool are accepted. |
| Syntax theme | GitHub | The theme diffs are highlighted with. Pick the same one as under Appearance in Paseo's settings, which plugins cannot read. |

The guide agent settings apply to guides written after you select **Use these for new guides**.

## Troubleshooting

| Message or symptom | What to do |
| --- | --- |
| **gh failed: …** or **glab failed: …** | Check `gh auth status` or `glab auth status` on the daemon's host. |
| **glab is not logged in to …** for a GitLab on a non-standard port | The plugin passes the host without its port. Set the port for that host in `glab`'s own config. |
| **… listing your reviews needs 19.2 or newer** | That GitLab is too old for the review list. Start the review from its URL instead. |
| **The guide agent's answer did not match what was asked for** | Select **Try again**, or pick a stronger model under **Provider and model**. |
| **GitLab did not keep the comment where it was put** | Comments on a whole file need GitLab 17.2 or newer. Comment on a line instead. |
| **gh failed: … could not be resolved** when saving a draft | The PR moved on since the guide was written. Comment on the whole file instead. |
| **GitLab did not record your request for changes: Reviewer not found** | Your drafts and body were published, but an older GitLab records a request for changes only from someone already listed as a reviewer. Add yourself as a reviewer on the merge request's page and request changes there. |
| No **PR updated since this guide** warning after a push | The forge could not be reached. Check `paseo plugin logs guided-review`. |

Run `paseo plugin logs guided-review` for more detail.

## Development

For development instructions, see the [root README](../../README.md#development).

Design decisions are in [docs/adr](docs/adr).
