# Eval terv: az ügynökök pontosítása méréssel, költségkerettel

Állapot: **részben megvalósítva.** A tárolás, a becslés, az összehasonlítás, az `eval` parancsok és a futtató szkript (`scripts/eval-run.mjs`) kész, hamis hoszttal tesztelve. Egyetlen **próbafutás** futott valódi ügynökkel (2026-11-17, 2 futás, 1 apró feladat): ennek mért adatai a "Mért adatok" fejezetben vannak. Összehasonlítás valódi feladatokon még nem készült. Ami nincs igazolva, azt a "Nyitott kérdések" fejezet sorolja fel.

## Cél

Megmondani, hogy egy ügynökprofil vagy vitamód változtatása **mérhetően** javít-e. A rendszer javaslatot ad, a módosítást a fejlesztő hagyja jóvá. Semmi nem íródik át magától.

## Nem cél

- A Colony nem hív modellt, és ez nem változik. A futtatást egy külön szkript végzi a hoston (a `scripts/` mappában, mint a `start.mjs`), kézzel indítva.
- Nem automatikus, ütemezett önhangolás. Az csak akkor jöhet szóba, ha a mérés megbízhatónak bizonyult.
- Nem "a modell szerint jó" pontozás. Csak objektív ellenőrzés számít.

## Elvek

1. **Objektív pontozás.** Egy futás akkor sikeres, ha a feladathoz rendelt ellenőrző parancs (teszt, pontos elvárt kimenet) zöld. Ezt a Colony `verify` parancsa már így rögzíti, a modell állítása nem számít.
2. **Ismétlés és szórás.** Az LLM nem determinisztikus: egy futás semmit nem bizonyít. Minden eredmény mellett szerepel az ismétlések száma és a szórás.
3. **Külön hangoló és ellenőrző készlet.** A variánsokat a hangoló készleten finomítjuk, a döntés az ellenőrző készleten múlik, amelyet hangolás közben nem használunk.
4. **Előbb becslés, aztán futás.** Minden futtatás előtt költségbecslés van, és kemény keret, amelynél a futás leáll.
5. **Javaslat, nem módosítás.** Az eredmény egy összehasonlító jelentés. A profil módosítása külön, emberi jóváhagyású commit.

## Adatmodell

**Feladatkészlet** (`.colony/eval/tasks.json` vagy a repó `eval/` mappája):

```json
{
  "set": "hangolo-1",
  "split": "tune",
  "tasks": [
    {
      "id": "t001",
      "title": "Javítsd a hibás összegző függvényt",
      "setup": "fixtures/t001",
      "prompt": "…a feladat szövege…",
      "check": ["node", "--test", "check.test.js"],
      "timeoutSec": 120
    }
  ]
}
```

- `split`: `tune` vagy `holdout`.
- `setup`: a futás előtt tiszta másolatba kerülő mappa, így minden futás azonos állapotról indul.
- `check`: argumentumlista, nem shell-sztring (mint a `verify`-nál), így nem fut le benne tetszőleges szöveg.

**Variáns:** egy név, egy profil- vagy módkonfiguráció (például a `dissenter` prompt két változata, vagy vitával és vita nélkül), és a futtatáshoz szükséges kapcsolók.

**Eredmény** (egy sor futásonként, a `.colony/eval/results.jsonl` fájlban, hash-láncolt auditnaplóval együtt):

| Mező | Tartalom |
|---|---|
| `variant`, `task`, `run` | melyik variáns, melyik feladat, hányadik ismétlés |
| `passed` | az ellenőrző parancs eredménye |
| `source` | `colony`: a Colony maga futtatta az ellenőrzést (`eval check`). `reported`: egy futtató jelentése, a Colony nem tudja ellenőrizni; az összehasonlítás alapból kihagyja. |
| `costUsd`, `inputTokens`, `outputTokens`, `turns` | amit a host kimenetéből a futtató kiolvas (ha a host jelenti) |
| `durationMs` | a host futásának ideje, **a futtató szkript méri** a host körül, nem a host állítása |
| `checkDurationMs` | a Colony saját ellenőrzésének ideje, nem a futás ideje |
| `debate` | váltások és hipotézisek (a `debate stats` adataiból); **még nincs megvalósítva** |

## Parancsok (megvalósítva)

| Parancs | Mit csinál |
|---|---|
| `eval validate --set <fájl>` | A feladatkészlet ellenőrzése, semmit nem futtat. |
| `eval estimate --set <fájl> --variants A,B --repeats N` | Becsli a hátralévő futásokat és a költséget (megadott `--cost-per-run` vagy már mért átlag alapján), `--budget-usd` kerettel. Nem futtat semmit. |
| `eval check ...` | A Colony maga futtatja a feladat ellenőrzését egy munkamappában, és rögzíti az eredményt (`colony` forrás). |
| `eval record ...` | Egy futtató jelentését rögzíti, `reported` címkével. |
| `eval compare --set <fájl> --variants A,B` | Fisher-féle egzakt próbával hasonlít össze; nyertest csak elég futásnál és a zajon kívüli különbségnél nevez. |
| `eval report --set <fájl>` | Futásszám és sikerarány variánsonként. |

A futtató szkript (`scripts/eval-run.mjs`): futásonként friss munkamappát készít a feladat `setup` mappájából (a projekten belül, a `.colony`-n kívül), a variánsfájlban megadott host-parancsot indítja benne, méri a futás idejét, majd az `eval check`-et hívja a költség-, kör- és tokenadatokkal. `--yes` nélkül nem indít semmit, éles futáshoz `--budget-usd` kell, és ha a host nem jelent költséget, az első futás után leáll (kivéve `--max-runs` esetén).

## Költségterv

### Képlet

```
költség = feladatok × ismétlések × variánsok × átlagos futásköltség
```

Az átlagos futásköltséget **nem találom ki**: a próbafutás méri meg.

### Kemény keretek

| Keret | Alapérték (javaslat) | Hatása |
|---|---|---|
| Futásonkénti körszám | 15 | a futás leáll, sikertelennek számít. **A telepített `claude` 2.1.322 súgójában nincs körszám-kapcsoló**, ezért ez jelenleg nem kényszeríthető. |
| Futásonkénti idő | a host időkorlátja (`--host-timeout-sec`, alapérték 600) | a futtató leállítja a folyamatot, a futás sikertelen (tesztelve hamis hoszttal) |
| Futásonkénti költség | a próbafutás átlagának 3-szorosa | a `claude --max-budget-usd` kapcsoló létezik a 2.1.322-ben, a próbafutás elfogadta, de a **túllépés viselkedését nem teszteltük** |
| Egy eval teljes kerete | előre megadott USD összeg | elérésekor az egész leáll, a részeredmény megmarad |
| Futtatás becslés nélkül | tiltott | az `eval estimate` kimenete jóváhagyás nélkül nem indít |

A keretek értékei a próbafutás után kerülnek véglegesre.

### Mintaszámítás (szemléltető, **nem mért adat**)

A táblázat csak azt mutatja, hogyan skálázódik a költség. A futásköltségek feltételezések, a valós árat a próbafutás adja.

| Feladat | Ismétlés | Variáns | Futás | Ha egy futás 0,05 USD | 0,20 USD | 0,50 USD |
|---|---|---|---|---|---|---|
| 10 | 3 | 2 | 60 | 3 USD | 12 USD | 30 USD |
| 20 | 3 | 2 | 120 | 6 USD | 24 USD | 60 USD |
| 20 | 5 | 3 | 300 | 15 USD | 60 USD | 150 USD |

### Mért adatok (próbafutás, 2026-11-17)

Egy valódi ügynökkel futtatva: `claude` 2.1.322, `claude -p --output-format json`, `--permission-mode acceptEdits`, a `Bash` eszköz tiltva, `--max-budget-usd 0.5` futásonként, a `claude` alapértelmezett modellje. Egy feladat (`hello`: hozz létre egy `hello.txt` fájlt, amely pontosan az `ok` szót tartalmazza), két futás, a Colony saját ellenőrzésével.

| | 1. futás | 2. futás |
|---|---|---|
| Eredmény | sikeres | sikeres |
| Költség | 0,189 USD | 0,086 USD |
| Körök | 3 | 3 |
| Bemeneti token | 6 | 6 |
| Kimeneti token | 288 | 251 |

- **Igazolt:** a kimenet tartalmaz költséget (`total_cost_usd`), köröket (`num_turns`) és tokent (`usage`), és egy futás összesen 0,275 USD-ba került két futásra (átlag kb. 0,14 USD). A futtató a `claude`-t Windowson közvetlenül indítani tudta, az eredmény a `colony` forrással rögzült, az auditlánc ép.
- **Korlátok:** két futás és a lehető legkisebb feladat. Ebből **átlagot és szórást nem lehet megbízhatóan számolni**, és egy valódi feladat tipikusan sokkal többe kerül. A két futás közti költségkülönbség okát nem vizsgáltuk (a bemeneti token kicsi, ezért gyanítható, hogy gyorsítótárból származik, de ez nem ellenőrzött).
- **Következmény a költségre:** 0,14 USD/futás mellett a kb. 90 futás/variáns mintegy 12–13 USD variánsonként, de **csak egy ilyen apró feladatnál**. A valós költséget egy valódi, kis feladaton kell újra megmérni, mielőtt nagyobb összehasonlítást indítunk.

### Hány futás kell?

Egy durva becslés: ha a sikerarány 50%-ról 70%-ra javul, kb. **90 futás variánsonként** kell ahhoz, hogy a különbséget 95%-os biztonsággal és 80%-os erővel észrevegyük. Kisebb javulás még többet kér. Ezért az `eval compare` nem mond "jobb"-at, ha a különbség a szóráson belül van.

Ez azt jelenti, hogy egy komoly összehasonlítás költséges. Ésszerű sorrend:

1. **Próbafutás** (1–2 feladat, 3 ismétlés): a futásköltség és a futtató működésének mérése.
2. **Kis készlet** (10 feladat): csak durva különbségek kimutatására.
3. **Nagyobb készlet** csak akkor, ha a kis készlet ígéretes.

### Költségcsökkentés

- Olcsóbb modell a mérés előszűrésére, a döntő futás a valós modellen.
- Rövid, gyorsan ellenőrizhető feladatok.
- A kudarc korai felismerése (körszámkeret), hogy a zsákutcák ne fussanak végig.
- Eredmények újrahasznosítása: azonos variáns és feladat nem fut újra, ha már van elég ismétlés.

## Kockázatok

| Kockázat | Védelem |
|---|---|
| Költség elszállása | kemény keretek, kötelező becslés |
| Zaj | ismétlés, szórás, a "jobb" állítás tiltása zajon belül |
| Túlillesztés | külön ellenőrző készlet |
| Önigazoló pontozás | csak objektív ellenőrzés |
| Beágyazott ügynök kockázata | a futtató külön szkript, kézzel indítva, tiszta mappában, jóváhagyással |
| A mérés a hostot is méri | az eredmény egy host és modell kombinációra érvényes, nem általános |

## Fázisok

1. **Próbafutás** kézzel: egy feladat, egy variáns, a költség és a kimeneti formátum mérése.
2. **Tárolás és összehasonlítás:** `eval record`, `estimate`, `compare`, tesztekkel (a futtató nélkül, mintaadatokkal).
3. **Futtató szkript** és a keretek.
4. **Első valódi összehasonlítás:** vitával és vita nélkül, a ROADMAP 1. fázisának adataival együtt.
5. Csak ezután: javaslatok a profilmódosításra, és az ütemezett futás kérdése.

## Nyitott kérdések (nem igazolt)

**Eldőlt a próbafutással** (a "Mért adatok" fejezet szerint): a `claude -p --output-format json` kimenete tartalmaz költség- és tokenadatot, és a `--max-budget-usd` kapcsoló létezik a 2.1.322-ben.

**Továbbra is nyitott:**
- Mennyi egy valós feladat átlagos költsége és szórása (a próbafeladat apró volt, két futás kevés).
- Mi a `--max-budget-usd` viselkedése, ha egy futás eléri: leáll-e tisztán, és mit ad vissza a kimenet.
- Körszám-korlát: van-e a használt verzióban erre mód (a 2.1.322 súgójában nincs `--max-turns`).
- Miért tér el a két futás költsége, és számít-e a gyorsítótár a mérésnél (azonos feladat ismétlése a gyorsítótár miatt olcsóbb lehet, ami torzítja az átlagot).
- Hány feladat elég ahhoz, hogy a kis készlet is mondjon valamit.
- A Cowork alatt futtatható-e a futtató szkript, vagy csak a Claude Code CLI-ben.
- A `debate` mező (váltások, hipotézisek) rögzítése a futásoknál még nincs megvalósítva.
- A `tune` és `holdout` szétválasztását a `split` mező csak rögzíti, a rendszer nem kényszeríti.
