# The guide agent reads the change with git

The guide prompt carries only what the forge alone knows: the description, linked issues, and the base and head commits.
The agent reads the commits, the file list and the diffs itself with git in the review's workspace, so the prompt stays the same size however large the change is.
This is why every review needs a checkout with its base and head commits fetched, and why the prompt pins the `git diff` options: the agent's hunk numbers have to match how the plugin cuts the forge's diff.
