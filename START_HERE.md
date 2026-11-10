# Start Here

Magyar / [English below](#english)

A Colony semmilyen LLM-szolgáltatót nem hív: a host (például a Cowork) maga a modell. Az indításhoz egyetlen utasítás kell, amit feladatadáskor a hostnak adsz. A hostra semmi mást nem kell telepíteni, csak Node.js 20+, pnpm és git.

## Ajánlott: a repó csatolása és egy `start`

1. Csatold a **colony-core** repót a hosthoz (a projekted mappája mellé). Ha még nincs a gépeden: `git clone https://github.com/Pocomotoxx/colony-core.git`.
2. Mondd a hostnak: **"Indítsd a colony-t a `[PROJEKTMAPPA]` projekten."** A host az `AGENTS.md` alapján a colony-core mappából ezt futtatja:

```
node scripts/start.mjs [PROJEKTMAPPA]
```

(vagy `pnpm start [PROJEKTMAPPA]`; ha a host a repó `.claude/commands` mappáját olvassa, `/colony-start [PROJEKTMAPPA]`.) Ez az első indításkor magától lefordítja a colony-core-t, bootolja a projektet, és kiírja a szabályokat, a munkamenetet és azt, hogy telepítve vannak-e a host hookjai. A `[PROJEKTMAPPA]` a **teljes útvonal**, és nem lehet maga a colony-core (az állapot a projektbe, a `.colony/` mappába kerül).

**Igazolt:** a `start` parancs és a launcher tesztelt (hibás megadásra érthetően leáll). **Nem igazolt:** hogy a Cowork olvassa-e az `AGENTS.md`-t és a `.claude/commands` mappát a csatolt repóból, és hogy a hookok futnak-e benne. Ha nem olvassa, a fenti mondat és útvonal akkor is elég: kérd a hosttól, hogy a colony-core mappából futtassa a `node scripts/start.mjs [PROJEKTMAPPA]` parancsot.

## Alap utasítás (klónozással, csatolás nélkül)

Másold be a hostnak, és cseréld ki a **[PROJEKTMAPPA]** és a **[FELADAT]** részt:

> Colony mód. Használd a `https://github.com/Pocomotoxx/colony-core` repót.
> 1. Klónozd a projekten **kívülre** (például a rendszer ideiglenes mappájába, `colony-core` néven; ha már ott van, `git pull`), majd abban a mappában futtasd: `pnpm install` és `pnpm build`. A colony-core kódját ne másold a projektbe.
> 2. A projekt mappája: **[PROJEKTMAPPA]**. Futtasd: `node <klón>/dist/cli.js boot --dir [PROJEKTMAPPA]` (a `<klón>` a klónozott mappa). Olvasd el teljes egészében a kimenetben kapott szabályokat. Csak akkor kezdj dolgozni, ha a boot állapota `LOADED` vagy `UNVERIFIABLE`. `BLOCKED` esetén állj meg, és jelentsd a pontos hibát.
> 3. Minden további colony-parancsnál add meg a `--dir [PROJEKTMAPPA]` kapcsolót. A feladatot a `task add` paranccsal vedd fel, a `next --as engineer` paranccsal kérd le, és `done --result "..." --quality 0..1` vagy `fail --error "..."` paranccsal zárd le.
> 4. Az eredményt ne találd ki: csak azt írd le, amit ténylegesen megtettél és ellenőriztél. A `--verified-by-test` kapcsolót csak akkor add meg, ha a teszt tényleg lefutott és zöld volt.
> Feladat: **[FELADAT]**

## Rövid utasítás

> Colony mód. Klónozd a `https://github.com/Pocomotoxx/colony-core` repót a projekten kívülre, `pnpm install && pnpm build`, majd `node <klón>/dist/cli.js boot --dir [PROJEKTMAPPA]`; olvasd el a szabályokat, minden további parancsnál használd a `--dir [PROJEKTMAPPA]` kapcsolót, és csak utána dolgozz. Feladat: **[FELADAT]**

## Tudnivalók

- A `[PROJEKTMAPPA]` az a mappa, amelyben a munka folyik. Az állapot (`.colony/`) és a szabályok (`.colony/rules/`) oda kerülnek, az első boot létrehozza őket. A colony-core kódja máshol van, a projektbe nem kerül.
- **Stabilitás:** ha a hostnak mindig a `main` ágat adod, az éppen aktuális kódot futtatja. Egy rögzített verzióhoz kérd, hogy a klónozás után `git checkout <commit>`-ot futtasson.
- A boot kimenete tartalmazza a szabályok szövegét. Ha boot után bármelyik szabályfájl megváltozik, a parancsok 2-es kóddal megállnak, és újra kell bootolni.
- A boot azt bizonyítja, hogy az állapot és a szabályok be lettek olvasva. Azt nem, hogy a host alkalmazta is őket.
- **Kézi mód:** így a modell írja a parancsokat. Az automatikus bizonyíték-rögzítés és a felidézés a host hookjait igényli (`hook install --apply`, Claude Code CLI-ben igazolt); hogy a Cowork futtatja-e őket, nem igazolt.
- A parancsok teljes listája és a boot állapotai: [README.md](README.md).

---

# English

The Colony calls no LLM provider: the host (for example Cowork) is the model. One instruction, given to the host with the task, is enough to start. Nothing else has to be installed on the host except Node.js 20+, pnpm and git.

## Recommended: attach the repository and say `start`

1. Attach the **colony-core** repository to the host (next to your project folder). If it is not on your machine yet: `git clone https://github.com/Pocomotoxx/colony-core.git`.
2. Tell the host: **"Start the colony on the `[PROJECT DIR]` project."** Following `AGENTS.md`, the host runs from the colony-core folder:

```
node scripts/start.mjs [PROJECT DIR]
```

(or `pnpm start [PROJECT DIR]`; if the host reads this repo's `.claude/commands`, `/colony-start [PROJECT DIR]`.) On the first start it builds colony-core by itself, boots the project, and prints the rules, how to work, and whether the host's hooks are installed. `[PROJECT DIR]` is the **full path** and must not be colony-core itself (the state goes to the project, in `.colony/`).

**Verified:** the `start` command and the launcher are tested (a wrong argument stops with a clear message). **Not verified:** whether Cowork reads `AGENTS.md` and `.claude/commands` from an attached repository, and whether the hooks run there. If it does not, the sentence and the path above are still enough: ask the host to run `node scripts/start.mjs [PROJECT DIR]` from the colony-core folder.

## Basic instruction (cloning, without attaching)

Paste it to the host and replace **[PROJECT DIR]** and **[TASK]**:

> Colony mode. Use the repository `https://github.com/Pocomotoxx/colony-core`.
> 1. Clone it **outside** the project (for example into the system temp folder as `colony-core`; `git pull` if it is already there), then run `pnpm install` and `pnpm build` in that folder. Do not copy the colony-core code into the project.
> 2. The project folder is **[PROJECT DIR]**. Run `node <clone>/dist/cli.js boot --dir [PROJECT DIR]` (`<clone>` is the cloned folder). Read the rules in the output in full. Start work only if the boot status is `LOADED` or `UNVERIFIABLE`. On `BLOCKED`, stop and report the exact error.
> 3. Pass `--dir [PROJECT DIR]` to every further colony command. Add the task with `task add`, fetch it with `next --as engineer`, close it with `done --result "..." --quality 0..1` or `fail --error "..."`.
> 4. Do not invent results: write only what you actually did and checked. Pass `--verified-by-test` only if the test really ran and was green.
> Task: **[TASK]**

## Short instruction

> Colony mode. Clone `https://github.com/Pocomotoxx/colony-core` outside the project, `pnpm install && pnpm build`, then `node <clone>/dist/cli.js boot --dir [PROJECT DIR]`; read the rules, use `--dir [PROJECT DIR]` on every further command, and only then work. Task: **[TASK]**

## Notes

- **[PROJECT DIR]** is the folder where the work happens. The state (`.colony/`) and the rules (`.colony/rules/`) go there; the first boot creates them. The colony-core code lives elsewhere and does not enter the project.
- **Stability:** if you always give the host the `main` branch it runs whatever is current. For a fixed version, ask it to run `git checkout <commit>` after cloning.
- The boot output contains the text of the rules. If a rule file changes after boot, commands stop with exit code 2 and the colony must be booted again.
- Boot proves the state and the rules were read and hashed. It does not prove that the host applied them.
- **Manual mode:** the model writes the commands. Automatic evidence and recall need the host's hooks (`hook install --apply`, verified with the Claude Code CLI); whether Cowork runs them is not verified.
- Full command list and the boot states: [README.md](README.md).
