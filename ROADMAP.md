# Roadmap

Magyar / [English below](#english)

Irány: **fókuszált fejlesztő-társ** egy fejlesztőnek: emlékezet + őrszem + ellenőrzés egy Claude Code-munkamenet köré. A többügynökös keret (11 szerep, szavazás) választható marad, de nem a termék magja.

**Alapelv:** csak azt állítjuk, amit igazolni tudunk. Minden fázisnak mérhető kilépési feltétele van; a becslések becslések, nem mérések.

## Döntések

| Téma | Döntés |
|---|---|
| Irány | A: fókuszált társ |
| Host | Claude Code először (stabilitás); a mag gazdagép-független, a hostot egy **adapter** köti be. Más host később, adapterként. |
| Nyelv | Dokumentáció és CLI-üzenetek magyarul **és** angolul |
| Mérés | A fejlesztő a saját munkáján használja és értékeli (1. fázis) |

## 0. fázis: használhatóvá tenni

Cél: a rendszer magától gyűjtsön, ne a modellre bízzuk.

- [x] Gazdagép-adapter réteg: a hook logika gazdagép-független hívásokon dolgozik, a Claude Code formátumát egy adapter fordítja.
- [x] **Élő próba az új eseményekről** (2026-11-10, Claude Code 2.1.281): a 0-s kilépés `PostToolUse`, a nem 0-s `PostToolUseFailure` (`error: "Exit code N
…"`); a `SessionStart` és `UserPromptSubmit` kontextusát a modell látja; a `CLAUDE_ENV_FILE`-ba írt `export` a Bash-parancsokhoz eljut. A `Stop` payload (`last_assistant_message`, `stop_hook_active`) mérve, még nem használjuk.
- [x] Automatikus bizonyíték: a teszt- és build-futtatások eredményét a hook rögzíti (`posttool`), a `done` ellenőrzésként használja. Élő végpontok közötti próba 2026-11-10-én sikeres valódi modellel (lásd `scripts/live/` és a README).
- [~] Munkamenet-azonosító: a `session` hook exportálja `COLONY_SESSION` néven (Bash-eszköznél mérve igazolt), a bizonyíték szűrése ezt használja. **Még nincs kész:** az audit `actor` mezője és a szavazás továbbra is a `--as` szöveg; a PowerShell-eszköz megkapja-e a változót, nem igazolt.
- [x] Felidézés a prompt előtt (`prompt` hook) és a munkamenet elején (`session` hook); a modellt arra kéri, hogy mutassa meg a felhasználónak. A megjelenítést a `recall.jsonl` rögzíti (az 1. fázis alapja).
- [x] `colony hook install [--apply]`: a hookok beolvasztása a `.claude/settings.json` fájlba **kifejezett kapcsolóval**, biztonsági másolattal. (A `.gitignore` beírása nincs: a `.colony/` tartalmát neked kell eldöntened, hogy verziókezelt-e.)

**Kilépés:** egy valódi munkanap úgy, hogy egyetlen `colony` parancsot sem gépelsz be kézzel.

## 1. fázis: megmérni, hogy ér-e valamit

- [ ] Felidézés-visszajelzés: minden megjelenített felidézésnél "hasznos / nem", helyi számlálókkal (semmi sem megy ki a gépről).
- [ ] Mérőszámok: a felidézés hasznossági aránya; ugyanazon hiba ismétlődése; fordulók száma colonyval és nélküle (felváltva, a saját munkán).
- [ ] **Kilépés:** legalább 30 értékelt munkamenet. 50% alatti hasznosságnál nem bővítjük a felidézést, hanem megvizsgáljuk az okát.

## 2. fázis: a keresés javítása valós adaton

- [ ] Valós feladatokból (magyar és angol) épített benchmark.
- [ ] Összehasonlítás ugyanazon a mércén: a mostani n-gramm beágyazás, BM25, magyar tőképzés, majd egy **választható** külső beágyazás külön csomagként. A mag nulla függőségű marad.
- [ ] **Kilépés:** csak akkor váltunk, ha az új megoldás a valós mércén bizonyíthatóan jobb.

## 3. fázis: megbízhatóság és skálázás

- [ ] Tárolás: hozzáfűzéses napló vagy `node:sqlite` (Node 22.5+; a támogatott Node-verziók döntését igényli).
- [ ] Felejtés: archiválás és tömörítés a régi feladatokra.
- [ ] Az audit fejének rögzítése git-commitban vagy tagben (külső, időbélyeges tanú).
- [ ] Mutációs és tulajdonságalapú teszt a `shell-paths.ts` elemzőre.

## 4. fázis: csiszolás és megosztás

- [ ] Kétnyelvű CLI-üzenetek és dokumentáció (nyelv: `.colony/config.json`).
- [ ] Gyorsindító (5 perc), bemutató munkamenet, npm-csomag.

## Amit nem csinálunk
Új szerepeket vagy szavazási módokat (amíg az identitás nem hiteles); a HNSW további fejlesztését (egy-parancsos használatnál a pontos keresés mérten gyorsabb); bármit, ami nem a 0–1. fázist szolgálja, amíg nincs mérés.

---

# English

Direction: a **focused developer companion** for one developer: memory + guard + verification around a Claude Code session. The multi-agent frame (11 roles, voting) stays optional but is not the core of the product.

**Principle:** we claim only what we can verify. Every phase has a measurable exit criterion; estimates are estimates, not measurements.

## Decisions

| Topic | Decision |
|---|---|
| Direction | A: focused companion |
| Host | Claude Code first (stability); the core is host-neutral and a **host adapter** wires it in. Other hosts later, as adapters. |
| Language | Documentation and CLI messages in Hungarian **and** English |
| Measurement | The developer uses and rates it on their own work (phase 1) |

## Phase 0: make it usable

Goal: the system collects by itself instead of relying on the model.

- [x] Host adapter layer: the hook logic works on host-neutral calls; an adapter translates Claude Code's format.
- [x] **Live probe of the new events** (2026-11-10, Claude Code 2.1.281): exit 0 fires `PostToolUse`, non-zero fires `PostToolUseFailure` (`error: "Exit code N
…"`); the context injected by `SessionStart` and `UserPromptSubmit` is seen by the model; an `export` written to `CLAUDE_ENV_FILE` reaches Bash commands. The `Stop` payload (`last_assistant_message`, `stop_hook_active`) is measured, not used yet.
- [x] Automatic evidence: the hook records test and build results (`posttool`); `done` uses them as the verification. End-to-end live check passed with a real model on 2026-11-10 (see `scripts/live/` and the README).
- [~] Session id: the `session` hook exports it as `COLONY_SESSION` (verified for the Bash tool), and evidence is filtered by it. **Not done yet:** the audit `actor` and voting still use the `--as` string; whether the PowerShell tool gets the variable is not verified.
- [x] Recall before the prompt (`prompt` hook) and at session start (`session` hook); the model is asked to show it to the user. Each shown recall is logged in `recall.jsonl` (the basis of phase 1).
- [x] `colony hook install [--apply]`: merges the hooks into `.claude/settings.json` **with an explicit switch**, keeping a backup. (No `.gitignore` entry: whether `.colony/` is versioned is your decision.)

**Exit:** one real working day without typing a single `colony` command by hand.

## Phase 1: measure whether it is worth anything

- [ ] Recall feedback: "useful / not" on every shown recall, with local counters (nothing leaves the machine).
- [ ] Metrics: usefulness rate of recall; repetition of the same mistake; number of turns with and without the colony (alternating, on your own work).
- [ ] **Exit:** at least 30 rated sessions. Below 50% usefulness we do not widen recall; we find out why.

## Phase 2: better search on real data

- [ ] A benchmark built from real tasks (Hungarian and English).
- [ ] Compare on the same yardstick: the current n-gram embedding, BM25, Hungarian stemming, then an **optional** external embedding as a separate package. The core stays dependency-free.
- [ ] **Exit:** switch only if the new approach is provably better on the real yardstick.

## Phase 3: reliability and scale

- [ ] Storage: append-only log or `node:sqlite` (Node 22.5+; needs a decision on supported Node versions).
- [ ] Forgetting: archive and compact old tasks.
- [ ] Anchor the audit head in a git commit or tag (an external, timestamped witness).
- [ ] Mutation and property-based tests for the `shell-paths.ts` parser.

## Phase 4: polish and sharing

- [ ] Bilingual CLI messages and documentation (language in `.colony/config.json`).
- [ ] Quick start (5 minutes), a demo session, an npm package.

## What we will not do
New roles or voting modes (until identity is authentic); further HNSW work (for one-command use the exact scan is measurably faster); anything that does not serve phases 0–1 until there is measurement.
