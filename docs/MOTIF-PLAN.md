# Motívum terv: újrahasznosítható munkafolyamat-sablonok

Állapot: **terv, nincs megvalósítva, kód sem készült.** Egy külső, "hat portos hiperél-architektúra" leírásból indul, de csak azt veszi át, ami a Colony alapelveivel összefér. Ami nincs igazolva, azt a "Nyitott kérdések" fejezet sorolja fel.

## Cél

Egy gyakori, bevált munkamenetet (például "elemzés, szintézis, kritika, ismétlés ellenőrzéssel") **névvel ellátott sablonként** menteni, és egyetlen paranccsal példányosítani. A Colony a sablon szabályait kényszeríti és naplózza: a kvórumot, az ismétlési korlátot és az ellenőrzőket. Hogy melyik sablon vált be, azt mérés dönti el.

## Nem cél

- **Nem futtató motor.** A Colony nem futtat ügynököket és nem küld nekik üzenetet: a host a modell. A motívum a host számára **utasítássorozat és nyilvántartás**, nem végrehajtó.
- **Nem aszinkron üzenetbusz, és nem elosztott infrastruktúra.** A leírásban javasolt PostgreSQL, Neo4j, Redis Streams és NATS ellentmond a Colony alapjának (helyi, egyfejlesztős, nulla futásidejű függőség, nincs hálózat a magban).
- **Nem hat külön port.** A hat port (elemzés, szintézis, kritika, absztrakció, rendszer, metakogníció) egy harmadik tengely lenne a 12 szerep és a vitamódok mellé. Nincs bizonyíték arra, hogy segít, ezért nem vezetjük be.
- **Nem önmódosító topológia.** A leírás szerint a metakognitív port futás közben új csomópontokat fűzhetne a gráfhoz. Ez ellenőrizetlen költséget és hurkot okozhat. Legfeljebb **javaslat** lehet, emberi jóváhagyással.
- **Nem YAML.** A YAML-értelmezőhöz külső függőség kell, a magban nulla futásidejű függőség van. A sablon JSON.
- **Nem automatikus összeállítás.** A rendszer javasolhat motívumot, de magától nem állít össze és nem indít.

## Összevetés a külső leírással

| A leírásban | A Colonyban |
|---|---|
| Hiperél kvórummal | Függőség a feladatok között (`--after`): a lépés akkor indul, ha az összes forrása kész. Az N-a-M-ből kvórum **új**, első változatban nincs (lásd Nyitott kérdések). |
| `max_iterations`, visszacsatolás | Felülvizsgálati körök korláttal (`--review`, `--max-review-rounds`), kimerülés után `hold` a felhasználónak. |
| Determinisztikus validátorok | `verify`: a Colony maga futtatja az ellenőrző parancsot, és rögzíti az eredményt. |
| Feltétel: `critique_score < 0.90` | **Nem vesszük át.** A pontszámot a modell mondja magáról. A feltétel az ellenőrző parancs vagy a reviewer ítélete (jóváhagy vagy elutasít) lehet. |
| Szerepkör és kritikus | A meglévő 12 szerep és a vitamódok (`reviewer`, `dissenter`). |
| TTL, kényszerített megszakítás | A lépésszám-korlát és a `hold`. |
| WL-hash a topológia azonosítására és a részgráf-hasonlóságra | Elsőre a **motívum azonosítója** és a **lépéslisták összevetése** (lásd "Hasonlóság"). A WL-hash később jöhet, ha szabadon összeállítható gráfok lesznek (lásd Fázisok). |
| Vektor + strukturális dupla index | A meglévő helyi memória és a Reasoning Bank, a motívum azonosítójával kiegészítve. |

## Eredet és megfeleltetés

Az ötlet egy hat portos, hipergráf-alapú "kognitív csomópont" leírásból indult ki: minden ágensnek hat logikai portja van (analízis, szintézis, kritika, absztrakció, rendszerszemlélet, metakogníció), és az ágensek kis, kipróbált mikro-topológiákba (motívumokba) szerveződnek. A lényeg **szerepek és kapcsolódási minták**, nem egy futtató motor. A Colonyban ezek nagy része más néven már megvan:

| Port | Mire való | Ami a Colonyban már van |
|---|---|---|
| P0 Analízis | nyers adat atomi tényekre bontása | `researcher`, `analyst`, `plan` (felbontás lépésekre) |
| P1 Szintézis | több forrásból egy terv | `architect`, a feladatok függőségei (az egész forrás-csatlakozás) |
| P2 Kritika, vétójoggal | megfigyel vagy blokkol | `reviewer` elutasítása, `hold` az auditortól |
| P3 Absztrakció | konkrét adatból séma és szabály | a Reasoning Bank mintái |
| P4 Rendszerszemlélet | másodrendű hatások | az `auditor` `watch` parancsa (hurok, ismétlődő hiba, eltérés a céltól), részben az `exobiologist` |
| P5 Metakogníció | konvergencia figyelése, ciklus leállítása | `watch` és `hold`; az új él menet közbeni bekötése **nincs**, és nem is cél |
| Hiperél / blackboard | több szerep közös kontextustere | a `debate`: egy javaslat körül minden szerep álláspontja és a kritikus válasza látható |

Ezért a hat port **nem lesz külön fogalom**: a meglévő szerepek és vitamódok a megfelelő tengelyek. Egy harmadik tengely bonyolítaná a rendszert, és nincs bizonyíték arra, hogy segít.

## Induló motívumok

Három induló sablon, mind a fenti leírásból, a Colony elveihez igazítva. A pontos lépések a megvalósításkor, a `motif validate` mellett kerülnek véglegesre.

| Motívum | Lépések | Hurok és ellenőrzés |
|---|---|---|
| `falsification-loop` (falszifikációs hurok) | elemzés, szintézis, kritika | a kritika `check` vagy reviewer-elutasítása visszaküld a szintézishez, legfeljebb `maxIterations` körig, utána `hold` |
| `semantic-compressor` (szemantikai kompresszor) | több elemzés, absztrakció, szintézis | nincs hurok; a sűrítés eredménye a szintézisnél kap ellenőrzést. A radar és a kutatás csatornák sok bemenetéhez illik ([RADAR-PLAN.md](RADAR-PLAN.md), [RESEARCH-PLAN.md](RESEARCH-PLAN.md)). |
| `risk-shield` (kockázati pajzs) | a munkafolyamat figyelése, csak eltérésnél lépés | **feltételes lépés**: a `watch` találatára indul (`onFinding`), és a `dissenter` különvéleményét is rögzíti. Nem blokkol önmagától, `hold`-ot az auditor tehet. |

A feltételes lépés új elem a sémában: `"runIf": "watch-finding"`, rögzített feltételek egyikével, szabad kifejezés nélkül.

## Hasonlóság: mi vált be hasonló feladaton

A külső leírás szerint a Weisfeiler-Lehman hash lehetővé tenné, hogy a rendszer részgráf-hasonlóság alapján is visszakeressen ("80%-ban megegyezik a múlt heti elemzéssel, csak két extra kritikai lépés kell"). Ezt pontosítani kell: **egyetlen WL-hash azonosságot jelez, hasonlóságot nem.** A százalékos hasonlósághoz gráfmag (kernel) vagy szerkesztési távolság kell.

Kis motívumkönyvtárnál ez egyszerűbben megoldható: a lépéslisták (szerep és mód párok) halmazkülönbsége.

```
motif similar <példány>   →   "A `falsification-loop`-pal egyezik, plusz egy `reviewer` lépés"
```

- A parancs a példány lépéseit veti össze a mentett motívumokéval, és megmutatja az eltérést (extra vagy hiányzó lépés).
- Ez **számolható, tesztelhető**, és a mintaszámot mindig mutatja.
- A WL-hash csak akkor kerül szóba, ha a sablonok szabadon összeállíthatók lesznek, és fel kell ismerni, hogy két különböző nevű felépítés ugyanaz.

## Átláthatóság: hogyan követhető egy motívumpéldány

A hipergráf-szerű működés fekete dobozzá válhat. Külső telemetria (például OpenTelemetry) külső függőség és hálózat lenne, ezért nem használjuk. Helyette:

- A Colony hash-láncolt **auditnaplója** már minden eseményt rögzít (ki, mikor, mit), és visszajátszható.
- `motif status <példány> --graph` ebből egy **Mermaid-diagramot** állít elő: a lépések, a függőségek, az iterációk és a lépések állapota (kész, folyamatban, `hold`).
- Minden iteráció külön csomópont, így látszik, melyik kör miért indult újra (melyik ellenőrzés vagy ítélet váltotta ki).

## Versenyhelyzetek

A külső leírás szerint az aszinkron portokon versenyhelyzet jöhet létre (egy szintézis lefut, mielőtt a lassabb elemzők végeztek). A Colonyban ezt három dolog kezeli:

- az állapotot **zár** védi, a parancsok egymás után futnak;
- a lépés csak akkor indul, ha az **összes forrása kész** (függőség);
- minden iteráció **új feladatpéldányokat** hoz létre, így egy elavult eredmény nem keveredhet egy újjal.

## Amit a Colony nem mér

A külső leírás szerint a metakognitív port a tokenfogyasztást is figyelné. **A Colony tokent nem mér**: a lépések számát és az időt tudja korlátozni, a tokenfogyasztást a hostnak kell jelentenie. A költségkeretet ezért lépésszámban adjuk meg ([EVAL-PLAN.md](EVAL-PLAN.md)).

## Elvek

1. **Csak megfigyelt bizonyíték dönt.** A visszacsatolási hurok feltétele egy `verify` eredmény vagy egy reviewer-ítélet, soha nem a modell önbecslése.
2. **Kemény korlátok.** Minden motívumnak van lépésszám-korlátja és ismétlési korlátja. Kimerülés után `hold` a felhasználónak, nem csendes folytatás.
3. **Egy iteráció, egy kör.** Minden ismétlés új feladatpéldányokat hoz létre iterációszámmal, így egy régi eredmény nem keveredhet egy újjal (a külső vázlat kvótája iterációtól függetlenül számolt, ez hiba).
4. **Deklaratív és ellenőrizhető.** A sablon JSON, érvényesítést kap (`motif validate`), és a kifejezések rögzített összehasonlítások, nem kiértékelt kódok.
5. **Javaslat, nem automatika.** A rendszer megmondhatja, mi vált be, a döntés a fejlesztőé.
6. **Mérés előbb.** A motívum nem alapértelmezett, amíg az [EVAL-PLAN.md](EVAL-PLAN.md) szerinti mérés nem mutatja, hogy javít.

## Sablonséma (JSON, tervezet)

```json
{
  "motif": "falsification-loop-v1",
  "description": "Elemzés, szintézis és kritika, ismétlés ellenőrzéssel",
  "steps": [
    { "id": "analyze",    "role": "researcher", "mode": "fact-finding", "title": "Gyűjtsd össze a tényeket" },
    { "id": "synthesize", "role": "architect",  "after": ["analyze"],    "title": "Készíts tervet a tények alapján" },
    { "id": "critique",   "role": "reviewer",   "after": ["synthesize"], "title": "Vizsgáld meg a tervet",
      "check": ["node", "--test", "check.test.js"] }
  ],
  "loops": [
    { "from": "critique", "to": "synthesize", "while": "check-failed-or-rejected", "maxIterations": 3, "onExhausted": "hold" }
  ],
  "budget": { "maxStepRuns": 10 }
}
```

- `after`: a lépés akkor indul, ha az összes felsorolt lépés kész (egész forrás-csatlakozás).
- `check`: argumentumlista, nem shell-sztring (mint a `verify`-nál), így nem fut le benne tetszőleges szöveg.
- `while`: rögzített feltételek egyike (`check-failed`, `rejected`, `check-failed-or-rejected`). Szabad kifejezés nincs.
- `mode`: a meglévő vitamódok egyike, a szerep két módjának valamelyike.
- `budget.maxStepRuns`: a lépésfuttatások összes száma a hurkokkal együtt.

## Parancsok (tervezettek)

| Parancs | Mit csinál |
|---|---|
| `motif list` / `motif show <id>` | A sablonok és a részletes leírásuk. |
| `motif validate <fájl>` | A séma, a hivatkozott szerepek, az ellenőrző parancsok alakja és a korlátok ellenőrzése. Nem futtat semmit. |
| `motif start <id> <cím> --dir` | Példányosítja a lépéseket a meglévő feladatkezelővel (mint a `plan --apply`), az iterációs számlálóval együtt. |
| `motif status <példány> [--graph]` | Hol tart: melyik lépés kész, hányadik iteráció, mennyi a hátralévő keret. A `--graph` Mermaid-diagramot ad az auditnaplóból. |
| `motif similar <példány>` | A példány lépéseinek összevetése a mentett motívumokkal: mivel egyezik, és mi az eltérés (extra vagy hiányzó lépés). |
| `motif stats` | Motívumonként: futások száma, átlagos minőség, az ellenőrzött futások aránya. Csak számok. |

## Mit kényszerít a Colony és mit nem

**Kényszeríti és naplózza:** a függőségeket (kvórum), az ismétlési korlátot, a lépésszám-keretet, a kimerülés utáni `hold`-ot, a `check` eredményét, a motívum és az iteráció azonosítóját.

**Nem tudja ellenőrizni:** hogy a host valóban a megadott szerepben és vitamódban érvelt-e, és azt sem, hogy a lépés tartalma jó. Ezt csak az ellenőrző parancs és a mérés mutatja meg.

## Tanulás

Minden lezárult motívumpéldányról a Reasoning Bank rögzíti a motívum azonosítóját és az eredményt (értékelt minőség, volt-e megfigyelt ellenőrzés). Új feladatnál a briefing **javaslatként** mutatja: "ezzel a motívummal korábban N futás, átlagos minőség X, ennyi ellenőrzött". Kevés futásnál (kezdetben 5 alatt, ez egy javasolt, kalibrálatlan érték) csak a számot mutatja, ajánlást nem.

## Költség

Minden lépés egy host-hívás, a hurok ezt megszorozza. A Colony **a lépések számát tudja korlátozni, a tokenfogyasztást nem méri** (azt a host jelenti).

```
lépésfuttatás ≤ lépések száma + (hurokban lévő lépések × maxIterations)
```

Szemléltető példa a fenti sablonra (nem mért adat): 3 lépés, a hurokban 2 lépés (`synthesize`, `critique`), `maxIterations` 3, vagyis legfeljebb 3 + 2 × 3 = **9 lépésfuttatás**, szemben egyetlen ügynök 1 hívásával. A költség tehát jelentős tényezővel nő.

- A `budget.maxStepRuns` kemény keret, elérésekor `hold`.
- A tokenköltséget az [EVAL-PLAN.md](EVAL-PLAN.md) költségfejezete szerint becsüljük és mérjük, a motívum futása előtt becsléssel.
- Ezért érdemes a motívumot olyan feladatra használni, ahol a hurok értéke a hibakeresés vagy az ellenőrzés, nem rutinfeladatra.

## Kockázatok

| Kockázat | Védelem |
|---|---|
| Elszálló költség a hurok miatt | lépésszám-keret, iterációs korlát, `hold`, becslés futtatás előtt |
| Önbecslésre épülő feltétel | a feltétel csak ellenőrző parancs vagy reviewer-ítélet |
| Régi és új iteráció keveredése | iterációnként új feladatpéldányok |
| Túl sok fogalom (port, szerep, mód) | portokat nem vezetünk be, a meglévő tengelyek maradnak |
| Futásidejű önbővülő gráf | nem része a tervnek; legfeljebb javaslat emberi jóváhagyással |
| A sablonban rejtett parancs | az `check` argumentumlista, a `verify` meglévő védelmei (nincs shell, destruktív parancsok tiltása) |
| Hamis biztonságérzet egy bevált motívumtól | a javaslat csak számokat mutat, a mintaszám mindig látszik |
| A mérés egy host-modell párra érvényes | az eredmény jelölése, általánosítás nélkül |

## Fázisok

1. **Séma és `motif validate`** tesztekkel (érvényes és hibás sablonok, tiltott kifejezések, korlátok).
2. **`motif start` és `status`:** példányosítás a feladatkezelővel, iterációs számláló, a lépésszám-keret és a `hold` kimerüléskor, tesztekkel.
3. **Az ellenőrző és a reviewer-ítélet bekötése** a hurok feltételébe.
4. **`motif stats` és a Reasoning Bank bekötése:** javaslat a briefingben.
5. **`motif status --graph` és `motif similar`:** Mermaid-nézet az auditnaplóból, lépéslista-alapú hasonlóság, tesztekkel.
6. **Az induló motívumok** (falszifikációs hurok, szemantikai kompresszor, kockázati pajzs a feltételes lépéssel).
7. **Mérés** az eval keretben: motívummal és anélkül, ugyanazokon a feladatokon.
8. **Csak ezután:** N-a-M-ből kvórum, és szabadon összeállítható sablonok esetén a WL-hash (vagy gráfmag) alapú strukturális azonosítás, ha addigra szükség van rá.

## Nyitott kérdések (nem igazolt)

- Hasznos-e a motívum a gyakorlatban a mostani feladat-ismétléshez képest. Ezt csak a mérés mutatja meg.
- Az N-a-M-ből kvórum szükséges-e, vagy elég az egész forrás-csatlakozás.
- Hogyan épüljön be az iterációszám a meglévő feladatmodellbe és az állapotmentésbe.
- Mennyi a motívum valós tokenköltsége egy tipikus feladaton (próbafutás kell).
- Elég-e a három rögzített hurokfeltétel, vagy kell-e több.
- A javaslat mintaszám-küszöbe (5): ez egy kiinduló érték, adatokból kell kalibrálni.
- Hogy a Cowork alatt is követi-e a host a motívum lépéseit.
- A feltételes lépés (`runIf`) pontos feltételei, és hogy a `watch` találatai elég stabilak-e erre.
- A `motif similar` hasznossága valós adaton: kell-e egyáltalán, vagy a motívum azonosítója elég.
- A Mermaid-nézet olvashatósága hosszú, sok iterációs példánynál.
