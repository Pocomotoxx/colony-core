---
description: Start the colony on a project folder (boot, rules, how to work)
argument-hint: <full path of the project folder>
---

Start the colony on the project folder given as the argument: `$ARGUMENTS`.

1. If no folder was given, ask the user for the full path of the project folder they want to work in. Never use the colony-core folder itself as the project.
2. From the colony-core folder, run: `node scripts/start.mjs "$ARGUMENTS"`. It builds colony-core if needed (the first time), boots the project, and prints JSON.
3. If `boot.status` is `BLOCKED`, stop and report `boot.problems` exactly. Otherwise read every rule in `rules` in full.
4. Tell the user in two or three lines: the boot status, whether `hooks.installed` is true (if not, show `hooks.hint` for THEM to run: you may not run it), and how many rules you read.
5. Follow `workflow` from the output for the work the user gives you next. Pass the same `--dir` on every colony command.
