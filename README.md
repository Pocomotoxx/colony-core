# Colony

Modellfüggetlen **Colony-mag** TypeScriptben. Nem hív LLM-et és nem kér API-kulcsot: a **host** (például a Cowork) maga a modell, a Colony pedig a főkönyve. Egy paranccsal (`colony boot`) betölti a rendszert, utána a host parancsokon keresztül dolgozik: feladatot vesz fel, kér, teljesít, szavaz, és a Colony vektoros memóriájába ír. Az állapot a repóban él (`.colony/`).

> **Állapot:** a projekt egy korábbi, rajalapú architektúrából indult, amelynek kódja már nincs a repóban. Az aktív mag a [`packages/colony-core`](packages/colony-core). A hátralévő munka terve: [plant.md](plant.md) és [docs/QUEEN-PORT-PLAN.md](docs/QUEEN-PORT-PLAN.md).

## Fogalmak

A korábbi „raj” (swarm) helyett mindenhol **Colony** a terminológia.

| Régi | Új |
|---|---|
| Swarm | Colony |
| Queen / coordinator | `ColonyHub` (vezérlő) |
| Agent registry | `ColonyRegistry` |
| Task orchestration | `ColonyTaskOrchestrator` |
| Worker agent | a host (Cowork), a `next` és `done` parancsokon át |

## Mit tud a `colony-core`

- **Koordináció:** ágensnyilvántartás (kapacitás, `idle`/`busy`/`offline`), feladatbontás függőségekkel, automatikus delegálás, eseménybusz témákkal és wildcarddal.
- **Konszenzus:** kvórum- és megbízhatósággal súlyozott szavazás. A kvórum rögzíthető, vagy stratégiából jön a szavazók számából: `majority`, `supermajority`, `byzantine` (3f+1), `unanimous`. Ha a kvórum már nem érhető el, a javaslat azonnal elutasítva lesz.
- **Foglalások (claims):** a `next` foglalást nyit a feladatra, a `done` / `fail` lezárja. Ha a gazdagép-munkamenet elhal, a foglalás elavul, és másik tag átveheti, vagy a gazda átadhatja. Az idő mindig paraméter, nincs időzítő és véletlen, ezért az egész visszajátszható.
- **Topológia:** a tagok kapcsolati gráfja (`mesh`, `star`, `tree`, `hybrid`), determinisztikusan: ugyanazokból a tagokból mindig ugyanaz a gráf. Vezetőválasztás, szomszédok, legrövidebb út.
- **Memória (Vector Codex):** szolgáltatófüggetlen embedding-felület, koszinusz-hasonlóságú vektortár névterekkel, fájlalapú perzisztencia a `.colony/memory.json` fájlban. A keresés alapból pontos (lineáris), 500 vektor fölött determinisztikus HNSW-gráf gyorsítja (`index: 'linear' | 'hnsw' | 'auto'`). A gráf nincs mentve, a tárolt dokumentumokból épül újra, mindig ugyanúgy.
- **Ágensek:** 11 beépített profil (Director, Architect, Coder, Reviewer, Tester, Security, Auditor, Researcher, Analyst, Writer, Exobiologist) és zod-alapú, típusbiztos eszköztár. Az Auditor és az Exobiologist **tanácsadó** szerep: csak olyan feladatot kap, amely név szerint kéri, a kiosztás nem teszi rájuk magától. Az Exobiologist nem szavaz. A profil `sampling` mezője (hőmérséklet, Top-P) csak javaslat a hostnak: a mag nem hív modellt, így nem tudja beállítani, és nem tudja ellenőrizni, hogy betartották-e.
- **Kiosztás pontozással (Colony Chief, P1):** a feladatot nem a legkevésbé terhelt tag kapja, hanem a legjobb pontszámú: képesség 0,30, terhelés 0,20, teljesítmény 0,25, egészség 0,15, elérhetőség 0,10. A súlyok a régi rendszerből jönnek, **heurisztikusak**, nem mért értékek. A teljesítmény a főkönyvből számolt, simított sikerarány (jelentett „kész", nem ellenőrzött minőség). Holtversenynél a tag azonosítója dönt.
- **Tanulás:** MoE-router és Reasoning Bank, amely a korábbi tapasztalatokat visszatáplálja. A router a szabályalapú pontszámra szavankénti, kimenetből tanult súlyokat ad (determinisztikus összeg, nincs beágyazásmodell és véletlen). Amit tanul, azt a host jelentette, nem ellenőrzött minőség. Minden lezárt feladatról (a hibásról is) strukturált jegyzet kerül az `outcomes` memórianévtérbe, a szabad szöveges eredmény és hibaüzenet nélkül; a hostile szöveg sem a Reasoning Bankba, sem ide nem kerül be, a visszautasítás az auditnaplóban van (`memory.refused`).
- **Host-vezérelt működés:** a `colony` parancssori eszköz JSON-t ír ki, így bármelyik host használhatja. A magnak nincs szüksége modellszolgáltatóra.
- **Boot:** a `colony boot` betölti és ellenőrzi az állapotfájlokat és a szabályfájlokat, feloldja a git-revíziót, és állapotot jelent (`LOADED`, `UNVERIFIABLE`, `BLOCKED`). Boot nélkül a munkaparancsok nem futnak.
- **Auditnapló:** minden változtatás hash-láncolt bejegyzés (SHA-256, aggregátumonként verzió). Szabad szöveg (eredmény, hibaszöveg, ellenőrzött parancs) nem kerül bele, csak a hossza vagy a döntés. Korlát: nincs aláírás, aki az egész fájlt átírja és újraszámolja a hash-eket, érvényes láncot kap. A boot rögzíti a napló végét, a következő boot ezzel fogja meg a levágást vagy az átírást; ez csak a két boot közti időre igaz.
- **Biztonság:** a fájlutak feloldott (symlink/junction követő) tartalmazás-ellenőrzéssel mennek át (`safe-path.ts`: szabályfájlok, `check --file`), a git-hívások nem hagyják, hogy a vizsgált repó saját parancsot futtasson (`core.fsmonitor`, `safe-git.ts`).
- **Nincs LLM-függés:** a magban nincs modellszolgáltató, hálózati hívás, API-kulcs vagy környezeti változó. A memória beágyazása helyi és determinisztikus.

## Gyors indítás

Szükséges: Node.js 20+ és pnpm.

```bash
cd packages/colony-core
pnpm install
pnpm build
pnpm test
```

Hostnak adható indítóutasítás: [START_HERE.md](START_HERE.md).

### Munkamenet: boot, majd munka

Minden parancs JSON-t ír ki. A `--dir <mappa>` a projektmappa (alapértelmezés: az aktuális mappa).

```bash
node dist/cli.js boot                                   # betöltés, állapot, munkaprotokoll
node dist/cli.js task add "Cím" "Leírás" --role engineer
node dist/cli.js next --as engineer                     # következő feladat + utasítás + memóriakontextus
node dist/cli.js done <taskId> --result "mit csináltam" # valós, nem üres eredmény kötelező
```

| Parancs | Mit csinál |
|---|---|
| `boot` | Betölti és ellenőrzi az állapotot, beregisztrálja a beépített tagokat, kiírja a protokollt. |
| `status` | Tagok, feladatok, nyitott javaslatok. |
| `task add <cím> <leírás>` | Új feladat (`--role`, `--after id,id`, `--priority`, `--consensus <kvórum>`). Szerep nélkül a MoE-router választ. |
| `next --as <szerep\|tag>` | A szerepnek kiosztott következő feladat, a szerep utasításával és a releváns memóriával. |
| `done <id> --result <szöveg> [--quality 0..1] [--verified-by-test]` | Lezárja a feladatot. Konszenzusos feladatnál előbb jóváhagyott javaslat kell. A Colony megjegyzi a megoldást. A `--quality` és a `--verified-by-test` a **host állítása**: a Colony tanul belőle (router, tagstatisztika, kiosztás), de nem méri és nem ellenőrzi. A jutalom sikernél `0,2 + 0,8 × minőség`, megadás nélkül 0,5. |
| `fail <id> --error <szöveg> [--quality 0..1]` | Hibásnak jelöli a feladatot. A jutalom mindig negatív: `-(1 - 0,3 × minőség)`, megadás nélkül -1. |
| `propose <id> <téma> --as <tag>` | Szavazást indít (`--quorum N` vagy `--strategy majority\|supermajority\|byzantine\|unanimous`, `--timeout-min`, alapértelmezés: 60 perc). Stratégiánál a szavazók a nem offline és nem hibás tagok. |
| `topology` | A tagok kapcsolati gráfja (`--type mesh\|star\|tree\|hybrid`, `--fanout`, `--degree`, `--from` és `--to` a legrövidebb úthoz). Csak olvas. |
| `review <feladat> --as <reviewer> --approve\|--reject --reason …` | A Critic-kör. Az elutasítás visszaküldi a feladatot `in_progress`-be, a tag a `next` kimenetében látja az indoklást (`reviewFeedback`). A harmadik elutasítás (feladatonként `--max-review-rounds N`, 1–20) után a feladat tartásba kerül, és a felhasználónak kell döntenie; a `hold release` friss körszámot ad. A `task add --review` jóváhagyáshoz köti a lezárást; az elutasítás enélkül is blokkolja a `done`-t, amíg új jóváhagyás nincs. Csak `reviewer` szerepű tag értékelhet, és nem azt a feladatot, amit ő tart. A jóváhagyás a reviewer állítása, nem tesztredmény; a Colony nem ellenőrzi. |
| `watch [--task id]` | A Deputy mechanikus ellenőrzése (csak olvas): azonos címmel ismétlődő hibák, ugyanaz a feladat újra és újra létrehozva, gazdát cserélgető foglalás, elakadt feladat, átnézetlen `chief.override`, a saját magától feloldott tartás, a napló sértetlensége és a boot-horgony, gyenge szöveges célcsúszás-jel (csak felbontott feladatnál). A `done` és `fail` kimenete is jelzi (`deputy`), ha az adott feladatról van mondanivalója; ez tanács, nem kapu. |
| `hold <feladat> --as <auditor> --reason …`, `hold release <feladat> --as <tag> --note …` | Tartás: a feladat nem fejezhető be (`done`) és nem osztható ki, amíg fel nem oldják; a `fail` marad. Tartást csak `auditor` szerepű tag tehet. A feloldás kötelező megjegyzése a host jelentése arról, mit döntött a felhasználó: **a Colony nem tudja ellenőrizni, hogy ember döntött-e.** Ha ugyanaz oldja fel, aki tette, a `watch` jelzi. |
| `plan <feladat> [--kind K] [--apply]` | Feladatelemzés: fajta (szerepből vagy szavakból), komplexitás, becsült idő (heurisztikus; legalább 3 mért befejezés után mért), témák, hasonló korábbi munka, bizonyosság, és a felbontás lépései szerepekkel, hullámokkal és stratégiával (`single`, `sequential`, `pipeline`, `parallel`, `fan-out-fan-in`, `hybrid`, a függőségi gráfból levezetve). Alapból csak javasol. Az `--apply` a lépéseket valódi feladatként hozza létre; a szülő az utolsó lépésre vár, és utolsóként zárul (jóváhagyás). Rövid (200 karakter alatti) feladat, ellenőrzés és részfeladat nem bomlik. |
| `health [--queue-depth N] [--long-wait-min N]` | A Colony egészsége (csak olvas): öt csoport (vezetés, kutatás, elemzés, végrehajtás, minőség) hibaaránnyal és válaszidővel, szűk keresztmetszetek (hosszú sor, hibás tagok, elavult vagy blokkolt foglalás, feladat, amit senki nem vehet át, bukott függőségre váró feladat), riasztások, javaslatok, átbocsátás, szavazási sikerarány. A küszöbök és a képletek heurisztikusak. |
| `score <feladat>` | A tagok rangsora a feladatra összetevőkre bontva, az elsődleges és legfeljebb két tartalék tag, és hogy a többi miért nem jöhet szóba. |
| `member list\|preset standard` | Tagok listája; a hiányzó beépített szerepek pótlása egy régebbi főkönyvben (idempotens). A boot csak üres Colonyt tölt fel. |
| `claim list\|sweep` | Ki mit foglal (`list`, csak olvas). A `sweep` stealable-re állítja az elavult (30 perc tevékenység nélkül) és a túl régen blokkolt (60 perc) foglalásokat. |
| `claim heartbeat\|block\|unblock\|release <feladat> --as <tag>` | Életjel (`--progress 0..100`; a stealable foglalást visszaveszi), blokkolás (`--reason`), feloldás, lemondás (azonnal átvehető). |
| `claim steal <feladat> --as <tag>` | Stealable foglalás átvétele a türelmi idő (10 perc) után, a tag kapacitásán belül. A feladat új gazdát kap. |
| `claim handoff <feladat> --as <tag> --to <tag> --reason <szöveg>`, `claim accept\|reject <feladat> --as <tag>` | Átadás: a címzett elfogadja vagy bármelyik fél elutasítja. |
| `check` | Kapuk, **mielőtt** a host cselekszik: `--command` (romboló parancs, titok), `--text`, `--file` (titokkeresés, `--diff-lines`, `--threshold`), `--tool` + `--allow` (eszköz-engedélylista). Döntés: `allow`, `warn`, `require-confirmation`, `block` (kilépési kód 3). A talált titkot soha nem írja ki. |
| `redact --text\|--file` | Mielőtt valami elhagyja a projektet (jelentés, kommentár): e-mail, bankkártya (Luhn), IBAN (mod 97), nemzetközi telefonszám, IP, JWT, adatbázis-URL és titkok cseréje helyőrzőre. `--hash kind,kind --salt S` sózott hash a helyőrző helyett (titokra soha). A nevet és a postai címet **nem** ismeri fel, olvasd át az eredményt. |
| `scan --text\|--file` | Prompt-injection megfogalmazás, rejtett karakterek (nulla szélességű, kétirányú vezérlők, Unicode címkék) és személyes adat keresése. Verdikt: `clean`, `suspicious`, `hostile` (kilépési kód 3). A személyes adatot fajta és darabszám szerint adja vissza, az értéket soha. A `memory add` a `hostile` szöveget elutasítja (`--allow-risky` felülírja), mert a memória később kontextusként kerül a host elé. |
| `route test\|teach\|stats` | A MoE-router: `test <szöveg>` megmutatja, melyik szerepet választaná (nincs mellékhatás), `teach <szöveg> --role R [--reward -1..1]` tanítja, `stats` a szerepek terhelését (Gini) és a tanultakat. A router a `done` (+0,5, mert csak jelentett) és a `fail` (-1) kimenetből is tanul. |
| `audit list\|verify` | A `.colony/audit.jsonl` hash-láncolt napló: ki mit tett (feladat, foglalás, szavazat, kapu-döntés). A `verify` a láncot és azt ellenőrzi, hogy a napló még tartalmazza az utolsó bootkor rögzített bejegyzést. |
| `vote <javaslat> --as <tag> --approve\|--reject --reason <szöveg>` | Szavaz (`--confidence 0..1`). Indoklás kötelező. |
| `memory add\|search` | Kézi memóriaírás és -keresés (`--ns`, `--k`). |
| `profile interview\|answer\|show\|reset` | A fejlesztői profil: fix, kihagyható kérdések lépésenként (`--section`, `--skip` = nincs preferencia). A válaszok a `.colony/profile.json` fájlba kerülnek; a szabad szöveg átmegy az injekciószűrőn és a kitakaráson. A `next` átadja az agentnek. |
| `rate <feladat> --quality 0..1` | Lezárt feladat utólagos értékelése. Te vagy az egyetlen megbízható forrás: az érték felülírja a bejelentettet, és a memória újratanulja. |
| `verify <feladat> [--timeout-sec N] -- <parancs…>` | A Colony **maga futtatja** az ellenőrzést (tesztek, build), és rögzíti a bizonyítékot (kilépési kód, a kimenet hash-e; maga a kimenet nem tárolódik). Bukó futás lerontja a minőséget (legfeljebb 0,3), és megnevezi az ellentmondást, ha a host azt állította, hogy a tesztek mentek. |
| `hook pretool\|install` | Őrszem egy host eszközhívás-horgához (lásd lent). |

### Mit lát az agent a feladat előtt

A `next` kimenete nem csak a feladatot adja, hanem azt is, amit a Colony tud:

- `profile`: amit a fejlesztő a munkamódjáról mondott (a kihagyott kérdések nincsenek benne);
- `recall.worked`: hasonló, jól értékelt korábbi munka (az értékeléssel, a hasonlósággal és azzal, hogy a Colony futtatott-e rá ellenőrzést);
- `recall.caution`: hasonló, rosszul értékelt munka, azaz amit nem érdemes megismételni;
- `recall.ask`: utasítás a hostnak, hogy mutassa meg ezt a felhasználónak, és kérdezze meg, alkalmazza-e, mielőtt nekilát. A felhasználó dönt.

Csak értékelt (`--quality`, `rate`) munka kerül a tanulási memóriába; a minősítetlen eredmény nem lesz csendben „tökéletes siker".

### Őrszem: a kapuk kikényszerítése

A `check` egy ellenőrzés, amit a host kedve szerint hív meg. Ha a host támogat eszközhívás-horgot (például Claude Code `PreToolUse`), a `colony hook pretool` ezt kikényszeríti: a hívás **előtt** megkapja az eszközhívást, és
megtagadhatja (`deny`) vagy rákérdeztetheti a felhasználóra (`ask`):

- shellparancs: romboló művelet, titok;
- fájlírás és -szerkesztés: a projekten kívüli út, a `.colony/` (állapot, szabályok) és a `.git/` közvetlen szerkesztése, titok, nagyon nagy írás (csak jegyzet).

A hook soha nem ad engedélyt (`allow` esetén nem ír semmit), csak elvehet; olvashatatlan bemenetnél megtagad (2-es kód). Beállítás: `colony hook install` kiírja a `.claude/settings.json` részletét (nem ír fájlt).
Korlát: csak azokat az eszközöket fedi, amelyeket a host a horoghoz kötött, és azt látja, ami az eszközhívásban benne van (futás közben összeállított parancsot vagy egy szkript belsejét nem).

### Párhuzamos hostok és a keresés minősége

- **Zárolás:** minden parancs a `.colony/state.lock` zár alatt fut, így két host nem írja felül egymás állapotát. A holt folyamat zárját a következő parancs átveszi; foglalt zárnál érthető hibával lejár.
- **Keresés:** a helyi beágyazás szavakat és szórészleteket (3- és 4-gramm) kivonatol, ékezetet hajtogat, és magyar–angol töltelékszavakat hagy el, így a ragozott alakok (`feladatokat` ~ `feladat`) közel esnek. Ez **lexikális** hasonlóság, nem jelentésmodell: közös betű nélküli rokonértelmű szavakat (`car` és `automobile`) nem köt össze. A `retrieval-quality` teszt méri: 16 kérdésen az 1. helyen találja a helyes régi munkát a kérdések 94%-ában (a korábbi beágyazás 6%). Saját modellt az `IEmbeddingProvider` felületen lehet bekötni; a régebbi memória egyszer újraszámolódik.

A boot állapotai (a Colony bootlogikája):
- `LOADED`: az állapotfájlok érvényesek, a git-revízió ismert.
- `UNVERIFIABLE`: az állapot érvényes, de a revízió ismeretlen. Tartalmi munka mehet, repómódosítás nem.
- `BLOCKED`: egy állapotfájl hibás, vagy egy kötelező szabályfájl hiányzik, üres vagy a szabálykönyvtáron kívülre mutat. A boot ezt rögzíti, és a munkaparancsok megtagadják a futást, amíg a hiba ki nincs javítva. Hibás állapotfájlt a rendszer soha nem ír felül csendben.

Ha a git-revízió megváltozott a boot óta, a parancsok figyelmeztetnek, hogy újra kell bootolni.

### Szabályok

A kötelező szabályokat a `.colony/rules/manifest.json` sorolja fel (`mandatory`), a fájlok ugyanabban a mappában vannak. Az első boot egy kis kezdőkészletet ír ki (munkaprotokoll, őszinte jelentés, konszenzus). Ezt utána a projekt szabadon átírhatja és bővítheti, a rendszer a meglévő fájlokat soha nem írja felül.

- A boot kimenete tartalmazza minden szabály szövegét és SHA-256 hash-ét. A host ezeket olvassa be.
- Ha boot után bármelyik szabályfájl megváltozik, eltűnik vagy olvashatatlan lesz, a munkaparancsok kódja 2, és újra kell bootolni.
- A boot a beolvasást és a hash-t bizonyítja, nem azt, hogy a host alkalmazta is a szabályokat.

## Repó felépítése

```
packages/colony-core/      az új mag (TypeScript, ESM, strict)
START_HERE.md              indítóutasítás hostoknak
AGENTS.md                  rövid belépő hostoknak
plant.md                   migrációs terv
```

A gyökérből `pnpm test` lefordítja és futtatja a `colony-core` tesztjeit.

## Ismert hiányok

- A `colony-core` tesztjei (`pnpm test`, 289 teszt) a buszt, a nyilvántartást, az orchestratort, a konszenzust, a vektortárat és a CLI teljes munkafolyamatát fedik (boot, szabályok, feladatok, szavazás, memória). A `ColonyHub`, a `FileVectorStore`, a MoE-router és a Reasoning Bank külön tesztelése még hiányzik.
- A szabályok csak kötelező készletből állnak, és mind a bootban töltődnek be. Feladathoz kötött szabálybetöltésre (útválasztóra) szándékosan nincs szükség.
- A kezdő szabálykészlet rövid, és a projekt igényeihez kell igazítani.
- Az ellenőrzések (`verify`) és az őrszem csak azt látják, amit a host megmutat vagy lefuttat; a Colony nem lát a host belsejébe. Az értékelés végső forrása a felhasználó.
- A beépített tagok (11 szerep) fixek; a `member preset standard` csak pótolja a hiányzókat. Egyedi tag felvétele és az ideiglenes tagok még nincsenek (P9 a [tervben](docs/QUEEN-PORT-PLAN.md)).
- A `plant.md` V. és VI. fázisa nincs leírva, és nincs bennük kész kód.

## Licenc

MIT, lásd a [LICENSE](LICENSE) fájlt.
