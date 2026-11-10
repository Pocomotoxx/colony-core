# Az elosztott ágensrendszer koordinátorainak átemelési terve (Colony Chief)

Állapot: 2026-11-01, átírva a 10 szerepes ügynökrendszer szerint. Terv, kód még nincs. Forrás: a régi rajkoordinátor (kb. 7400 sor a hat nagy fájlban, már nincs a repóban) és a felhasználó ügynökrendszer-terve.

## Mit olvastam el, és mit nem

| Fájl | Sor | Olvasva |
|---|---|---|
| a régi központi koordinátor fájlja | 2035 | típusok, konfig, `analyzeTask`, a felbontás, képességek, `delegateToAgents`, pontozás, kiválasztás, egészségjelentés (eleje), konszenzus, tanulás. **Nem** olvastam: 870–1100 (komplexitás, időbecslés, domain-választás, mintaillesztés, bizonyosság), 1560–1700 (egészség vége). |
| `unified-coordinator.ts` | 2099 | csak a metódusjegyzék |
| `attention-coordinator.ts` | 1007 | fejléc, típusok |
| `federation-hub.ts` | 997 | fejléc, típusok, metódusjegyzék |
| `agent-pool.ts` | 539 | csak a metódusjegyzék |
| `message-bus.ts` | 737 | nem olvastam |
| `domain/`, `application/` | ? | nem olvastam |

A terv ezért a központi koordinátorra (az új név: Colony Chief) részletes, a többire vázlat. A P0 lépés pótolja a hiányt, mielőtt kódot írnánk.

## Alapgondolat

A régi központi koordinátor hat dolgot csinál: **elemez → kioszt → pontoz → egészséget figyel → szavaztat → tanul a kimenetből**. Ő hajtotta végre is a munkát (ügynök-pool, időzítők, `waitForTaskCompletion`). A Colonyban a munkát a host végzi, ezért a **Colony Chief tanácsadó és nyilvántartó**: tiszta, determinisztikus függvények, amelyek javaslatot adnak, és a host dönt. A végrehajtó gépezet nem kerül át.

Az ügynökrendszer három eleme **új a régi kódhoz képest**, és külön fázist kap: a **Deputy** (független felügyelet), a **Critic-kör** (visszaküldés korláttal) és az **emberi kapu** (eszkaláció). Ezeket a régi rendszer nem tudta.

## A szereplista (11 szerep)

A felhasználó 15 szerepes terve itt 10 szerepre van összevonva, és kiegészül az **Exobiológussal** (11. szerep, lásd P11). Az összevonás indoka: minden szerep egy host-munkamenet vagy egy külön forduló, és a koordinációs költség gyorsabban nő, mint a haszon. Ha egy összevonással nem értesz egyet, a terv csak a szereplistát érinti.

| Szerep (`AgentRole`) | A terv szerepe | Állapot ma | Megjegyzés |
|---|---|---|---|
| `director` | Orchestrator, a **Colony Chief** gazdája | van | Ő hívhatja a `chief-override`-ot. |
| `auditor` | **Deputy / Executive Audit** | **új** | Eseményvezérelt, nem átjáró (P5). |
| `security` | Jogi és Etikai biztos | van | A mechanikus kapukat futtatja (`check`, `scan`, `redact`), és „a mintákra nem volt találat" szöveggel jelent, nem „megfelelő"-vel. |
| `researcher` | Deep Research + Data Scraper + Data Cleansing | **új** | A három szerep egy. A lekérés a host képessége; a kimenet a `scan` és a `redact` kapuján megy át. |
| `analyst` | Data Analyst & Reasoning | van, profil nincs | Profilt kap. |
| `exobiologist` | **Exobiológus**: anomália-hipotézisek | **új** | Nem kap feladatot a szokásos kiosztással, nem szavaz a kvórumban, és nem ír éles kódot. Csak az anomália-sorból dolgozik (P11). |
| `architect` | Code Architect | van | |
| `engineer` | Developer | van | |
| `writer` | Content Creator & Copywriter | **új** | |
| `reviewer` | Critic / Reviewer | van | A Critic-kört vezeti (P6). |
| `tester` | Sandbox & Test Execution | van | A host futtat; **ő az egyetlen szerep, amely ellenőrzött bizonyítékot adhat.** |

Nem szerep, hanem a mag szolgáltatása:
- **Context & RAG Manager** → a `memory` (VectorCodex, HNSW) és a `scan` a belépésnél. Nem külön ügynök.
- **Synthesis & Narrative** → a Chief `synthesize` parancsa (P8).
- **Token & Compute Budget** → **kimarad.** A host-vezérelt magban nincs API, így költség sem, amit mérni lehetne; a modellt a host választja. (A régi `colony-cost-tracker` ugyanezért esett ki a C listán.) Legfeljebb egy szabad megjegyzés a feladaton.

A beépített tagok így 6-ról 11-re nőnek (`director`, `architect`, `engineer`, `reviewer`, `tester`, `security` + `auditor`, `researcher`, `analyst`, `writer`, `exobiologist`). A mai főkönyvekben 6 tag van: a tagok pótlása külön, kifejezett parancs (`member preset`, P9), nem csendes változás a bootban.

## Fázisok

> **Állapot:** a P0–P6 kész (2026-11-01), 248 teszt zöld. Az eredmények a fázisok szakaszainak végén.

### P0 – Előkészítés (kicsi, kód nélkül)

- Elolvasni a hiányzó részeket: a központi koordinátor 870–1100 és 1560–1700, `unified-coordinator` `assignTask` és `scoreAgentForTask` (801–905), `message-bus.ts`, `domain/`, `application/`. Ha a `message-bus.ts` tud valamit, ami a Colony `MessageBus`-ából hiányzik (prioritás, visszaigazolás, holtlevél-sor), az külön tétel.
- **Tagstatisztika alapja:** a főkönyvből és az auditnaplóból levezetett mutatók tagonként (befejezett, hibás, átlagos időtartam, utolsó tevékenység). Nem új tár, a meglévő adatokból számolt.

**P0 eredménye (elolvasva):**
- **Központi koordinátor 870–1100.** A komplexitás: 0,3 alap + 0,1 részfeladatonként + 0,05 függőségenként, prioritásszorzó (kritikus 1,3 … háttér 0,8), típuspótlék, leírás hossza legfeljebb +0,2, legfeljebb 1,0. Az időbecslés: típusalap × (0,5 + 1,5 × komplexitás) + a részfeladatok fele. Mind kézzel megadott szám. A régiben van `background` prioritás, a Colonyban nincs. A hash-alapú „beágyazás" a régi kódban 768 dimenziós szóhash: ugyanaz a gyengeség, mint a Colony mostani beágyazásáé (szóegyezés, nem jelentés).
- **`unified-coordinator` `assignTask` / `scoreAgentForTask` (801–905).** Egy másik pontozás: 100 alap, +50 típusegyezés, −20 × terhelés, szorozva az egészséggel, +10 × sikerarány, −5 × átlagos végrehajtási perc. **A régi rendszerben két, egymástól eltérő pontozás élt egymás mellett** (ez és a központi koordinátor 0,30/0,20/0,25/0,15/0,10-es súlyozása). A Colony a központi koordinátor-félét vette át, mert az összetevőkre bontva magyarázható.
- **`message-bus.ts` (737 sor).** Nem a Colony `MessageBus`-ának megfelelője: ügynökök közti, pont-pont üzenetsor prioritással, visszaigazolással (`requiresAck`), lejárattal és újrapróbálkozással. A Colony busza téma-alapú értesítés. A régi ahhoz kellene, ha a tagok *postaládát* kapnának (üzenet egy tagnak). Ez nincs a tervben; ha igény lesz rá, új tétel.
- **`domain/` és `application/` (kb. 2070 sor).** DDD-burok az ügynök- és feladat-entitások körül (`Agent`, `Task`, repository-felületek, parancsok). A Colony `ColonyRegistry` és `ColonyTaskOrchestrator` ugyanezt adja, átvenni való nincs.
- **Tagstatisztika:** a feladatokból és a foglalásokból számolt, nem tárolt (`chief/member-stats.ts`).

### P1 – Szerepek és pontozás

A régi pontszám súlyai: képesség 0,30, terhelés 0,20, teljesítmény 0,25, egészség 0,15, elérhetőség 0,10.

- Új szerepek (`auditor`, `researcher`, `writer`, `exobiologist`), öt új beépített profil (`auditor`, `researcher`, `analyst`, `writer`, `exobiologist`).
- A profilba egy **`sampling` javaslat** kerül (például `temperature`, `topP`) *tanácsként*: a mag nem hív modellt, ezért nem tudja beállítani, és azt sem tudja ellenőrizni, hogy a host betartotta-e. A host dönt. A `boot` és a `next` kimenete mutatja a javaslatot.
- Az `exobiologist` kikerül a normál kiosztásból (csak kifejezett szerepmegadással kap feladatot) és a kvórum szavazói közül.
- `chief/scoring.ts`, `colony score <feladat>`: minden tag pontszáma összetevőkre bontva. Képesség = szerep és eszköz egyezés; terhelés = `currentTaskIds / maxConcurrentTasks`; teljesítmény = tényleges sikerarány a P0 statisztikából; egészség = hibás/offline állapot és elavult foglalások; elérhetőség = `idle`/`busy`.
- Elsődleges tag + legfeljebb 2 tartalék (küszöb 0,3, mint a régiben).
- **Viselkedésváltozás (döntés: igen):** a pontozás váltja fel a mai „legkevésbé terhelt" kiosztást a `tryDispatchTask`-ban. Holtversenynél a tag azonosítója dönt.
- **Összekötés a foglalásokkal:** az elavult foglalásnál a `claim sweep` kiírja a legjobb átvevő tartalék tagot.
- Teszt: súlyok, holtverseny, tartalék, régi és új kiosztás összevetése, az új szerepek betöltése, a 6 tagos régi főkönyv épségben marad.

**P1 eredménye (kész):** új szerepek (`auditor`, `researcher`, `writer`, `exobiologist`) és 11 beépített profil `sampling` javaslattal; `chief/member-stats.ts`, `chief/scoring.ts`; `colony score`, `colony member list|preset standard`; a kiosztás pontoz (`ColonyTaskOrchestrator.setRanker`); a `claim sweep` megnevezi a legjobb átvevőt (üres, ha nincs más jogosult tag, nem találja ki). Az `auditor` és az `exobiologist` **tanácsadó szerep** (`ADVISORY_ROLES`): csak név szerint kérve kap feladatot, a szavazók közül az `exobiologist` kimarad. Eltérések a tervtől: az auditor is kikerült a hallgatólagos kiosztásból (a függetlensége miatt), és a `member preset standard` már a P1-ben kész (a P9 csak a `legacy-15` sablont és az ideiglenes tagokat adja hozzá). Ismert korlát: a „képesség" összetevő csak szerepegyezést és az előírt képességek lefedését méri, a feladat szövegét nem veti össze a tag profiljával.

### P2 – Egészségjelentés

- `chief/health.ts`, `colony health`: tagok, csoportok („domainek"), szűk keresztmetszetek (sorhossz 10 fölött, hibás tagok, elavult foglalások), figyelmeztetések, javaslatok.
- **A régi hiány:** a domain-egészségnél az `avgResponseTimeMs` és az `errorRate` egyaránt fixen 0 volt („Would need tracking"). Itt a foglalásokból (átfutási idő) és az auditnaplóból (hibás/összes) valósan számoljuk.
- A „domain" a terv hat csoportja: Vezetés és ellenőrzés, Kutatás, Elemzés, Végrehajtás, Minőség (és a memória a szolgáltatásoknál). A szerepek csoportokra képezve, nem fix ügynökszámokra.
- Kimarad: `coordinationLatencyMs` (futásidejű mérőszám).

**P2 eredménye (kész):** `chief/health.ts`, `colony health`. Csoportok: vezetés (`director`, `auditor`, `security`), kutatás (`researcher`, `exobiologist`), elemzés (`analyst`), végrehajtás (`architect`, `engineer`, `writer`, `custom`), minőség (`reviewer`, `tester`). A hibaarány és a válaszidő a feladatokból számolt (a régiben fix 0 volt). Az üres kapacitás nem hiba (a régi csoport-egészség minden szabad kapacitásért büntetett). A régihez képest új leletek: feladat, amit senki nem vehet át (szerepenként egy lelet, nem feladatonként), bukott vagy törölt függőségre váró feladat, hosszan várakozó feladat. Heurisztikus: a küszöbök (sor 10/20, hibaarány 0,1, várakozás 60 perc), a csoport-egészség képlete (sornyomás + fél hibaarány + az offline tagok aránya) és az összesített érték (a csoportok átlaga mínusz súlyosság szerinti levonás). A régi `calculateOverallHealth` (1560–1700) nincs elolvasva, az összesítés saját. Ismert korlát: az egészség csak a főkönyvből látszó dolgokat méri, a host munkamenetének tényleges állapotát nem.

### P3 – Elemzés, felbontás, végrehajtási terv

- `chief/analysis.ts`, `colony plan <feladat>` (csak olvas) és `colony plan <feladat> --apply` (valódi részfeladatokat hoz létre `parentId`/`dependencies` kitöltésével; a mezők megvannak a `ColonyTask`-ban).
- Sablonok a régiből: kódolás (terv → megvalósítás → teszt), tesztelés, kutatás, koordináció. Új sablon: **kutatás → elemzés → szintézis → ellenőrzés**, és **szöveg: vázlat → írás → átnézés**. Az egyszerű feladat (200 karakter alatt) nem bomlik.
- **Végrehajtási stratégia a függőségi gráfból:** a részfeladatok hullámokra bontása (mi futhat egyszerre). A régi öt stratégianevet a gráf alakjából vezetjük le.
- A mintaillesztést a meglévő Reasoning Bank adja.
- **Heurisztikák (döntés: igen):** a régi időtartamok és a komplexitás-képlet kézzel megadott számok, nem mérések. `heuristic` jelölést kapnak, felülírhatók, és ahol van mért adat (P0 statisztika), az az erősebb.
- A régi `memoryMb`, `cpuIntensive`, `networkRequired` kimarad.

**P3 eredménye (kész):** `chief/analysis.ts`, `colony plan <feladat> [--kind K] [--apply]`, `ColonyTaskOrchestrator.splitTask`, `ColonyHub.analyze`. Sablonok: kódolás (terv: `architect` → megvalósítás: `engineer` → teszt: `tester`), tesztelés, kutatás (`researcher` → `analyst` → `director` összegzés → `reviewer` ellenőrzés), koordináció, szöveg (`writer` vázlat → `writer` írás → `reviewer` átnézés), általános (egy lépés). A lépés szerepet kap (a régi „domain" helyett). A stratégia a gráfból jön: `single`, `sequential` (lánc), `pipeline` (lánc legalább 3 lépéssel és 3 szereppel), `parallel`, `fan-out-fan-in`, `hybrid`; a mai sablonok mind láncok, a többi alak az `executionWaves`/`strategyOf` függvényekben él, tesztelve. **Eltérések a régitől:** a Colony-feladatnak nincs típusa, ezért a `fajta` a kért szerepből, ennek híján a szavakból következik (a szerep az erősebb, mert a „teszt" szó egy megvalósítási feladat szövegében is előfordul); a komplexitás, az időbecslés és a bizonyosság a régi képlet, `heuristic` jelöléssel; ha egy szerepre legalább 3 mért befejezés van, a becslés ezt használja (a mért idő a várakozást is tartalmazza); az erőforrás-becslés (memória, CPU, hálózat) kimarad; a részfeladat nem bomlik újra. **A felbontás szemantikája:** a szülő nem kezdett feladat (`pending` vagy `assigned`, nem `in_progress`), az `--apply` után `pending`, a lépésekre (a levelekre) vár, és az utolsó lépés után kerül kiosztásra: ő a jóváhagyás. Érvénytelen felbontás (ismeretlen kulcs, kör, kettős kulcs) semmit nem változtat. A `plan` jelzi, ha egy lépés szerepéhez nincs online tag. Ismert korlát: a mintaillesztés a mai szóegyezéses beágyazáson alapul (küszöb 0,4, a régi 0,6 másik beágyazásra volt hangolva).

### P4 – Tanulás a kimenetből

- `done --quality 0..1` (nem kötelező). Jutalom a régi képlettel: siker esetén `minőség × 0,8 + 0,2`, kudarcnál `minőség × 0,3`.
- Betáplálás a routerbe (ma +0,5/−1 fix) és a tagstatisztikába; kimenet a memóriába egy `outcomes` névtérbe.
- **Őszinteség:** a minőséget a host adja meg. A jutalom és a statisztika „jelentett", nem ellenőrzött, a kimenetben is így címkézve. Az egyetlen ellenőrzött jel a `tester` által futtatott teszt, amelyet külön mezőben lehet rögzíteni (`--verified-by-test`, ami szintén a host állítása, de a címkéje elkülönül).

**P4 eredménye (kész):** `chief/outcome.ts`; `done --quality 0..1 --verified-by-test`, `fail --quality 0..1`. A jutalom: siker `0,2 + 0,8 × minőség` (megadás nélkül 0,5), kudarc `-(1 - 0,3 × minőség)` (megadás nélkül -1). **Eltérés a régitől:** a régi kudarc-jutalom `minőség × 0,3` volt, ami sosem negatív, tehát a hibázó szerep felé mozgatta a tanulót; itt minden kudarc negatív. A minőség a feladaton tárolt, a router, a Reasoning Bank pontszáma és a tagstatisztika (`avgQuality`, `qualityReports`, `verifiedCompleted`) használja; a kiosztás teljesítmény-összetevője 70% sikerarány + 30% átlagminőség, ha van jelentett minőség (heurisztikus). Az `outcomes` névtérbe minden lezárt feladatról (a hibásról is) strukturált jegyzet kerül, a szabad szöveges eredmény és hibaüzenet nélkül. A `--verified-by-test` külön címke, **nincs súlya**, és a host állítása marad: a Colony nem tudja ellenőrizni. **Két hibát találtam közben, és javítottam:** (1) a `FileVectorStore` versenyhelyzete: két egyszerre induló írás közül a második betöltés törölte az első dokumentumait, és az egyidejű mentések felülírhatták egymást (a regressziós teszt a régi kódon elbukik); (2) a `ReasoningBank.recallPatterns` az explicit `minScore: 0`-t 0,25-re cserélte (`||`). **Rés zárva:** a `done --result` szövege eddig szűrés nélkül került a Reasoning Bankba, az `aidefence` kapuja csak a `memory add`-ot védte; most a hostile szöveg nem tárolódik, a visszautasítás az auditnaplóba kerül.

### P5 – Deputy: eseményvezérelt felügyelet és tartás (hold)

A terv szerint a Deputy a Chief döntéseit auditálja: célcsúszás, végtelen ciklus, káros részdöntések, és vétójoga van. Három módosítással kerül be:

1. **Nem átjáró.** Nem minden feladat megy át rajta (az soros szűk keresztmetszet lenne), hanem eseményre fut: `done`/`fail`-nél, ismételt hibánál, hurok gyanújánál, `chief-override` után.
2. **Mechanikus ellenőrzés, nem ítélet.** `colony watch` az auditnaplóból és a főkönyvből: ugyanaz a feladat N-szer bukott (alapérték 3); egy foglalás körbejár (átvétel/átadás ≥ 3); egy feladat elakadt; egy `chief-override`-nak nincs átnézése; a részfeladatok címei elszakadnak a gyökérfeladat szavaitól. **A „célcsúszás" jelzés gyenge**, mert a mai beágyazás hash-alapú, tehát szóegyezést mér, nem jelentést. A kimenet ezt kimondja.
3. **A vétó eszkaláció, nem egyoldalú javítás.** `colony hold <feladat> --as <auditor> --reason …` a feladatra *tartást* tesz: a `done` és a `next` megtagadja, amíg valaki fel nem oldja. A feloldás (`hold release`) kötelezően megad egy megjegyzést arról, mit mondott a felhasználó. **A CLI nem tudja igazolni, hogy ember oldotta fel**, a megjegyzés „jelentett", és az auditnaplóba kerül.

**Független-e a Deputy?** Ha ugyanaz a modell, mint a Chief, a hibáik korrelálnak. A függetlenség forrása az eltérő *információ* (az eredeti kérés szövege, az auditnapló, a mért számok), nem a „másik fejjel gondolkodás". Ezt a README is kimondja.

**P5 eredménye (kész):** `chief/watch.ts`, `colony watch [--task id]`, `colony hold` / `hold release`, `ColonyTask.hold`, `holdTask` / `releaseHold`. Eseményvezérelt: a `done` és a `fail` kimenete hozza a feladatra vonatkozó, nem alacsony súlyú megállapításokat (`deputy`), tanácsként, nem kapuként. **Ellenőrzések** (mind számlálás vagy összehasonlítás a rekordokon, küszöbük heurisztikus és felülírható): a napló lánca és a boot-horgony (kritikus); átnézetlen `chief.override` és a saját magától feloldott tartás (magas; az override-ot a P7 hozza létre, az ellenőrzés addig is kész); azonos címmel ≥3 bukott feladat (magas); ugyanaz a feladat ≥3-szor létrehozva, egy sem zárult (közepes); egy foglalás ≥3 gazdacserével (magas); nyitott feladat 120 percig rekord nélkül (közepes); tartás, ami még nyitva van, és szöveges célcsúszás-jel (alacsony). **A tartás:** csak `auditor` szerepű tag teheti, a `done` és a kiosztás megtagadja, a `fail` nem; a `next` kihagyja; az `health` külön jelzi. A feloldás megjegyzése a host jelentése a felhasználó döntéséről (redaktálva, 200 karakterre vágva kerül az auditnaplóba). **Őszinte korlátok** (a `watch` kimenete is kiírja): a Colony nem tárolja az eredeti felhasználói kérést, ezért a célcsúszás ellene nem mérhető, csak a felbontott feladatok részei a gyökérhez képest, szóegyezéssel (gyakori szavak nélkül); a tartás feloldásáról nem tudja, hogy ember döntött-e; a Deputy függetlenségét a rekordok adják, nem egy második vélemény. **Közben kijavítva:** a célcsúszás-jel az „a/the"-szerű gyakori szavakon is egyezést látott (stopszólista bevezetve).

### P6 – Critic-kör korláttal

- `colony review <feladat> --as <reviewer> (--approve | --reject) --reason …`. Az elutasítás visszaküldi a feladatot `in_progress`-be a megjegyzéssel, és növeli a körszámot.
- **Maximális körszám (alapérték 3).** A harmadik elutasítás után a feladat automatikusan *tartásba* kerül, és eszkalál az emberhez (P5 mechanizmusa). A rajzon ez a hiányzó ág volt.
- Az elfogadás nélkül a konszenzusos feladat nem zárható (ma is így van a szavazásnál); a `review` ezt kiegészíti egy minőségi kapuval, amelyet a feladat létrehozásakor lehet kérni.
- Auditnapló: minden kör bejegyzés.

**P6 eredménye (kész):** `chief/review.ts`, `colony review`, `task add --review [--max-review-rounds N]`, `ColonyTask.reviewRequired/maxReviewRounds/reviewRounds/reviews`, `ColonyTaskOrchestrator.recordReview`. **Szabályok:** csak `reviewer` szerepű tag értékelhet; az nem, aki a feladatot tartja (a függetlenség minimuma); csak `in_progress` vagy `review` állapotú munka értékelhető; indoklás kötelező (redaktálva, 300 karakterre vágva tárolódik, az auditnaplóba csak a hossza és a verdikt kerül). Az elutasítás `in_progress`-be küldi vissza, és számol egy kört; a limit (alapérték 3) elérésekor a feladat tartásba kerül (`review-limit` a tartó), az auditnaplóban `task.held`. A lezárás blokkolva van, ha a legutóbbi verdikt elutasítás (a nem kért értékelésnél is), vagy ha az értékelés kötelező és nincs jóváhagyás; a `fail` mindig lehetséges. **Friss körszám:** ha a felhasználó (a host jelentése szerint) feloldja a review-limit tartását, a körszám nullázódik; más tartás feloldása nem nullázza. A `next` kimenete (`reviewFeedback`) mutatja az utolsó elutasítás indoklását. **Őszinte korlát:** ha ugyanaz a modell írta a munkát és értékeli is, az értékelés ugyanazokat a vakfoltokat örökli; a jóváhagyás nem tesztredmény. Egy egyszerűsítés: nincs külön „beküldöm értékelésre" parancs, az értékelő a futó munkát bírálja; ha ez kell, a `submit` kis kiegészítés.

### P7 – Két hiányzó szavazási mód

- **`weighted`:** a szavazat súlya = a tag teljesítménye × egészsége (a régi képlet). A régi kódban ez sokáig hatástalan volt (a súlyok sosem jutottak el a számláláshoz, minden súlyozott döntés sima többség lett; egy 2026-os javítás hozta rendbe). Itt a súly a szavazat leadásakor kerül a szavazatba és az auditnaplóba, a számlálás tesztelve van arra, hogy a súly valóban számít.
- **`chief-override`:** egyoldalú döntés, csak három típusra (vészhelyzeti művelet, tag leállítása, prioritás-felülbírálat). **Hatalom, nem szavazás**, ezért: csak `director` szerepű tag hívhatja, indoklás kötelező, mindig az auditnaplóba kerül, a `status` külön jelzi, és **a Deputy utólag megjelöli** (`watch` jelez, ha nincs átnézése). A felhasználó a végső döntő; a P5 tartása felülírhatja a következményeit.
- A `propose` kiterjesztése; tesztek a súlyozott kvórumra és a visszaélésre (nem `director`, hiányzó indoklás, nem engedett típus).

### P8 – Több tag kimenetének összegzése (az attention-coordinator maradéka)

- A régi fájl hat figyelemmechanizmust kínál (multi-head, flash, linear, hyperbolic, moe, graph-rope). A saját fejléce szerint a flash gyorsulása „unverified". 10–15 tagnál a pontos softmax-figyelem triviálisan gyors, a közelítések nem adnak semmit.
- Átvesszük a lényeget: `colony synthesize <feladat>`: több jelentésből kiválasztja a „középsőt" (amelyik a többihez a leghasonlóbb), megadja az egyetértési pontot és a kilógókat. A régi `neural/utils/self-consistency.ts` (134 sor) ide illik, azt is át kell nézni.
- **Korlát:** a hasonlóság szóegyezést mér, nem jelentést. A kimenet jelzi.
- Kimarad: flash, linear, hyperbolic, graph-rope.

### P9 – Ideiglenes tagok és sablonok (a federation-hub használható része)

- `colony member add --ephemeral --ttl-min N`: az al-munkamenet (alügynök) ideiglenes tagja lejárattal; `member sweep` leveszi, a feladata a foglalás-elavulás útján átvehetővé válik. A régi `setInterval`-os takarítás és `Math.random()` azonosító helyett kifejezett söprés és determinisztikus azonosító.
- `colony member preset <név>`: a hiányzó beépített tagok pótlása a 10 szereplistára (`standard`), és egy opcionális, régi **15 ügynökös** sablon (`legacy-15`), amely a tagokat `offline` állapotban hozza létre (az `offline` tag nem szavaz és nem kap feladatot, amíg egy host be nem jelentkezik helyette).
- A `broadcast`, az optimális rendszer kiválasztása és a föderációs szavazás hálózati/több telepítéses: P10.

### P11 – Anomália-sor és Exobiológus

Az Exobiológus feladata: amit a standard elemzés vagy a Critic zajnak, hibának vagy értelmezhetetlennek bélyegez, azt ne dobja el senki csendben, és legyen, aki 2–3 radikálisan más hipotézist ad hozzá. A tervben három pillér van; ebből kettő a magban megvalósítható, egy nem.

**Ami nem valósítható meg a magban: a hőmérséklet és a Top-P.** A Colony nem hív modellt, a mintavételezést a host állítja. A mag legfeljebb *javaslatot* ír a profilba (P1 `sampling`: 0,8–1,0 / magas Top-P az Exobiológusnak, 0,0–0,2 az elemzőnek), és nem tudja ellenőrizni, hogy betartották-e. Egy ellenőrizhető, host-oldali megfelelő: több független, eltérő piszkozat kérése ugyanarra a mintára; a Colony ezeket rögzíti.

**Ami megvalósítható:**

1. **Anomália-nyilvántartás (a legértékesebb rész).** `colony anomaly add --task T --as <szerep> --sample … --dismissed-as noise|error|unclear --reason …`: aki valamit zajnak bélyegez, rögzíti, mit dobott el és miért. A minta a `scan` és a `redact` kapuján megy át. Így az elvetett adat nyoma megmarad, az auditnaplóba is bekerül.
2. **Hipotézis-életút.** `colony anomaly hypothesize <id> --as <exobiologist> --hypothesis … --prediction … --test …`. Egy anomáliához legfeljebb 3 hipotézis. **Kötelező mezők:** egy ellenőrizhető előrejelzés (mi látszana, ha igaz) és a legolcsóbb próba. Ez a védelem a puszta hallucináció ellen: aminek nincs cáfolható előrejelzése, az nem kerül be.
   Állapotok: `proposed` → `testing` → `supported` | `refuted` | `untestable`. A `proposed` és az `untestable` hipotézis **sosem tény**: a kimeneten `speculative` címke áll, a Reasoning Bankba és a memóriába csak `supported` jut, és az is a `hypotheses` névtérbe, jelölve.
3. **Ellenőrzés.** `colony anomaly judge <id> --as <auditor|reviewer> …`: a logikai és gyakorlati helytállást a Deputy vagy a Critic mondja ki. Az, hogy egy hipotézis `supported`, csak a `tester` által futtatott próbával lehet (`--verified-by-test`, ami szintén a host állítása, de külön címkével). Az ítélet mellé a Deputy `watch`-ja jelzi, ha egy anomália megválaszolatlan (nincs hipotézis vagy nincs ítélet).
4. **Inverz RAG.** `colony memory search <kérdés> --far <mód>`: nem a leghasonlóbb találatot adja. Három mód: `cold` (a legkevésbé vagy soha nem lekért dokumentumok, ehhez lekérdezési számláló kell a tárban), `foreign` (más névtérből, a kérdéshez nem tartozó), `far` (a kérdéstől legtávolabbi vektorú). **Őszinte korlát:** a mai beágyazás hash-alapú, tehát a „távol" itt szó szerinti különbözőséget jelent, nem jelentésbeli távolságot, és a `far` majdnem véletlen dokumentumokat ad. A `cold` és a `foreign` ettől független, és szerintem hasznosabb. Jelentésalapú távolsághoz a hostnak kellene beágyazást adnia, ez külön döntés.

**Őrök a visszaélés ellen:**
- Csak az anomália-sorból dolgozik, nem ír éles kódot, és az „ne alkalmazz bevált gyakorlatot" utasítás csak a hipotézis-alkotásra szól, a megvalósításra nem.
- Költségkorlát: legfeljebb 3 hipotézis anomáliánként, és legfeljebb N (alapérték 5) nyitott anomália egyszerre; ezen felül a `watch` jelez.
- A hipotézis a döntéseket nem befolyásolja (nem szavaz, nem kap súlyt a kiosztásban), amíg `supported` nem lett.

**Mit nem tudok garantálni:** hogy a hipotézisek *jók*. A rendszer a rossz hipotézist nem szűri ki, csak azt, hogy cáfolhatatlan és ellenőrizetlen állítás ne váljon ténnyé. A minőséget a próba dönti el.

Tesztek: életút és tiltott átmenetek, a 3 hipotézis korlát, a kötelező előrejelzés, `speculative` címke, titok az anomália-mintában (nem kerül ki), `cold`/`foreign` keresés és a számláló, a memóriába csak `supported` jut.

### P10 – Több Colony egymás közt (csak tervezés)

Hálózat nélkül csak git-alapú csomagcsere lehet (hash-ellenőrzött export és import). Külön tervként kell megírni, nem a régi kódból.

## Ami nem kerül át, és miért

- `agent-pool` (acquire/release/skálázás/egészségellenőrző szál) és a `unified-coordinator` futtató része: a host maga az ügynök, a skálázás az ő dolga. Amit hasznosat tud (pontozás, heartbeat, helyreállítás), azt a P1 és a foglalások lefedik.
- `waitForTaskCompletion`, háttérszálak, szüneteltetés/folytatás: futtató gépezet.
- A Token & Compute Budget szerep (nincs mit mérni).
- A hálózati és időzítős részek.

## Sorrend, méret, függőségek

| Fázis | Függ | Becsült méret | Kockázat |
|---|---|---|---|
| P0 | – | olvasás, leltár | alacsony |
| P1 | P0 | ~350 sor + tesztek | közepes (megváltozik a kiosztás, új szerepek) |
| P2 | P0 | ~250 sor + tesztek | alacsony |
| P3 | P1 | ~400 sor + tesztek | közepes (a heurisztikák minősége) |
| P4 | P0 | ~150 sor + tesztek | alacsony |
| P5 | P0, P4 | ~350 sor + tesztek | közepes (új állapot a feladaton: tartás) |
| P6 | P5 | ~200 sor + tesztek | alacsony |
| P7 | P1 | ~250 sor + tesztek | **magas** a `chief-override` miatt |
| P8 | P1 | ~250 sor + tesztek | alacsony |
| P9 | P1 | ~250 sor + tesztek | alacsony |
| P10 | P9 | külön terv | – |
| P11 | P1, P5, P6 | ~450 sor + tesztek | közepes (a hipotézisek minősége, a `cold` keresés számlálója a tárban) |

Ajánlott menet: P0 → P1 → P2 → P4 → P3 → P5 → P6 → **P11** → P7 → P8 → P9. Mindegyik külön commit, tesztekkel és a README, migrációs térkép és leltár frissítésével, ahogy eddig.

## Döntések

| # | Kérdés | Döntés (2026-11-01) |
|---|---|---|
| 1 | Név | **Colony Chief** (`ColonyChief`, modul: `chief/`). A tagszerep `director` marad, ő hívhatja a `chief-override`-ot. |
| 2 | A pontozás váltsa fel a mai kiosztást | Igen. |
| 3 | `chief-override` | Igen: három típusra, indoklással, auditnaplóval, csak `director` szerepű tagnak, a Deputy utólagos megjelölésével. |
| 4 | Ügynökrendszer | A felhasználó terve, **10 szerepre összevonva** (lásd fent). A régi 15 ügynökös hierarchia csak opcionális sablon (`legacy-15`, P9), alapból `offline` tagokkal. |
| 5 | Becslések | Igen: `heuristic` jelöléssel, felülírható alapértékként. |
| 6 | Exobiológus | Új szerep (11. szerep), a P11 szerint: anomália-nyilvántartás, kötelezően cáfolható hipotézisek, `speculative` címke, a hőmérséklet csak javaslat a profilban. |

## Nyitott pont

- A 10 szerepre való összevonás (Scraper + Cleansing + Deep Research egy `researcher`; Synthesis a Chief-nél; a Budget kimarad) az én javaslatom a terv alapján. Ha külön szerepként kell valamelyik, a P1-et érinti.
