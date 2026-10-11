# Drafts live on the forge

A comment is saved to the forge as a draft the moment the reviewer saves it: a thread on the viewer's pending review on GitHub, a draft note on GitLab.
The plugin keeps no copy of a draft, and every listing reads the forge, so drafts started on the web show up in the panel and a draft survives the plugin's data being lost.
The cost is a forge round trip per save, and anchoring a draft on lines the forge's own diff has.
Locally the plugin keeps only what the forge cannot hold: which concept a draft was written from, the passage it was highlighted from, the review body until submit, and GitHub's comments on the change as a whole, which GitHub has no draft for.
