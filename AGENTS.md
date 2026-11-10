# Agents

Magyar / [English below](#english)

Ez a repó a **Colony**: az eszköz, nem a projekt, amelyen dolgozol. A munkát a felhasználó **projektmappájában** végzed; a colony az állapotát (`.colony/`) oda írja, nem ide.

## Indítás

Ha a felhasználó azt kéri, hogy indítsd a colony-t (vagy "start"), kérd el tőle a **projektmappa teljes útvonalát**, ha nem adta meg, és a colony-core mappából futtasd:

```
node scripts/start.mjs <projektmappa>
```

Ez szükség esetén lefordítja a colony-core-t, bootolja a projektet, és JSON-t ír ki: az állapotot (`boot.status`), a szabályokat (`rules`), azt, hogy telepítve vannak-e a host hookjai (`hooks`), és a munkamenetet (`workflow`).

- `BLOCKED` esetén állj meg, és jelentsd a `boot.problems` tartalmát szó szerint.
- Olvasd el a szabályokat teljes egészében, és csak utána dolgozz.
- A `workflow` lépéseit kövesd, és minden colony-parancsnál add meg ugyanazt a `--dir` kapcsolót.
- Ha a hookok nincsenek telepítve, a `hooks.hint` parancsot **a felhasználónak** mondd meg: te nem futtathatod (a guard megtagadja).
- A projektmappa **nem** lehet maga a colony-core.

A slash-parancs (ha a host támogatja a repó `.claude/commands` mappáját): `/colony-start <projektmappa>`. A teljes leírás: [START_HERE.md](START_HERE.md), a parancsok: [README.md](README.md).

---

# English

This repository is the **Colony**: the tool, not the project you work on. You do the work in the user's **project folder**; the colony writes its state (`.colony/`) there, not here.

## Start

When the user asks you to start the colony (or says "start"), ask them for the **full path of the project folder** if they did not give it, and run from the colony-core folder:

```
node scripts/start.mjs <project folder>
```

It builds colony-core if needed, boots the project, and prints JSON: the state (`boot.status`), the rules (`rules`), whether the host's hooks are installed (`hooks`), and how to work (`workflow`).

- On `BLOCKED`, stop and report `boot.problems` verbatim.
- Read the rules in full, and only then work.
- Follow the `workflow` steps and pass the same `--dir` on every colony command.
- If the hooks are not installed, tell the **user** to run the `hooks.hint` command: you may not run it (the guard refuses it).
- The project folder must **not** be colony-core itself.

The slash command (if the host reads this repo's `.claude/commands`): `/colony-start <project folder>`. Full description: [START_HERE.md](START_HERE.md); commands: [README.md](README.md).
