# Eval terv: az ügynökök pontosítása méréssel, költségkerettel

Állapot: **részben megvalósítva** (a kalibráló futás a `hard-1` készleten mindkét modellnél plafont mutatott, lásd lent). A tárolás, a becslés, az összehasonlítás, az `eval` parancsok és a futtató szkript (`scripts/eval-run.mjs`) kész (hamis hoszttal tesztelve, majd valódi ügynökkel kipróbálva). Két **próbafutás** futott valódi ügynökkel (2026-11-17: egy apró feladat 2 futással, egy kis hibajavítás 5 futással, együtt kb. 0,76 USD becsült, API-egyenértékű költség; Pro-előfizetéssel a valódi ár a használati keret): a mért adatok a "Mért adatok" fejezetben vannak. Összehasonlítás még nem készült, mert a próbafeladatok túl könnyűek a variánsok megkülönböztetéséhez. Ami nincs igazolva, azt a "Nyitott kérdések" fejezet sorolja fel.

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

> **Mit jelent itt a "USD":** a `claude` által jelentett `total_cost_usd` mező, a **tokenhasználat API-egyenértékű becslése**, nem fizetett összeg. A mérések egy **claude.ai fiókkal (Pro csomag)** bejelentkezett `claude`-dal futottak, nem API-kulccsal, ezért a Claude API konzol 0 USD-t mutat: a valódi ár a csomag **használati keretéből** fogy, amelyből mennyi, azt a `total_cost_usd` nem mondja meg (a claude.ai használati oldala mutatja). A `--budget-usd` keret ugyanebben az egységben korlátoz, tehát a **felhasználás arányos korlátja**, nem a számláé. API-kulccsal futó host esetén ugyanez a szám közel a tényleges ár. A Groq csak a radarban fut (ingyenes szint kvótája), az eval-futások a `claude`-on mennek, mert a mérésnek ugyanazon a modellen kell futnia, mint a munkának.

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

### Mért adatok (két próbafutás, 2026-11-17)

Mindkét próba ugyanazzal a beállítással futott: `claude` 2.1.322, `claude -p --output-format json`, `--permission-mode acceptEdits`, a `Bash` eszköz tiltva, `--max-budget-usd 0.5` futásonként, a `claude` alapértelmezett modellje, a Colony saját ellenőrzésével. A két próba együtt kb. **0,76 USD becsült (API-egyenértékű) költség**, a Pro-keretből fogyott rész ismeretlen.

#### 1. próba: `hello` (a lehető legkisebb feladat)

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
#### 2. próba: `slug` (egy valódi, kis hibajavítás)

Feladat: a `src/slug.js` hibás `slugify` függvényét kell kijavítani (kisbetű, ékezetek eltávolítása, a nem betű/szám karakterek sorozata egy kötőjel, nincs kötőjel a végeken, üres bemenetre üres szöveg), a látható tesztek (`test/slug.test.js`, 4 eset) alapján. Az ellenőrzés a munkamappán **kívül** van (`checks/slug-check.mjs`), 12 esetet futtat, így az ügynök nem írhatja át, és többet ellenőriz, mint a látható tesztek. Előzetesen igazolt: a hibás kódon bukik, egy referenciamegoldással átmegy. 5 futás, 1 variáns.

| | 1. | 2. | 3. | 4. | 5. |
|---|---|---|---|---|---|
| Eredmény | sikeres | sikeres | sikeres | sikeres | sikeres |
| Költség (USD) | 0,094 | 0,096 | 0,095 | 0,097 | 0,100 |
| Host-idő (s) | 11,8 | 12,4 | 14,6 | 13,9 | 14,3 |
| Kimeneti token | 696 | 835 | 742 | 903 | 924 |
| Körök | 5 | 5 | 5 | 5 | 5 |

Összesen 0,481 USD, átlag **0,096 USD/futás**, a szórás kb. 0,002 USD. A teszteket az ügynök nem módosította (az első futásnál ellenőrizve).

- **Igazolt:** a host futásának ideje a futtató mérésében kerül a `durationMs` mezőbe (kb. 12–15 s), a Colony ellenőrzése külön (`checkDurationMs`, kb. 80 ms). A rejtett ellenőrzés a teszt-átírás kerülőútját kizárja.
- **A feladat túl könnyű a méréshez.** Ha minden futás sikeres, a sikerarány (100%) nem tud különbséget mutatni két variáns között: 5 futásból a 95%-os intervallum alsó széle 0,57. Egy változtatás hatásának méréséhez olyan feladat kell, amelyen a sikerarány 30 és 70% között van.
- **Nem igazolt:** hogy ez a költség általános (egy feladat, egy variáns, egy modell). A bemeneti token minden futásnál 6, ami gyorsítótárra utal: az azonos feladat ismétlése olcsóbb lehet, mint egy hideg indítás, ami torzítja az átlagot. Ezt nem vizsgáltuk.

#### Következmény a költségre

- Ezen az apró feladaton kb. 0,10 USD/futás mellett a kb. 90 futás/variáns mintegy **8–9 USD variánsonként**, két variánsnál 17 USD körül.
- Ez **alsó becslés**: egy nehezebb feladat, amelyen a variánsok eltérnek, valószínűleg futásonként többe kerül. Nehezebb feladattal még nem mértünk.
- A következő lépés ezért nem több futás ugyanezen a feladaton, hanem **nehezebb, a sikerarányt 30–70% közé hozó feladatok** megírása, és azon újra mérni a költséget.

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

## A nehezebb feladatkészlet: `eval/hard-1`

Az első két próbafeladat (egy fájl létrehozása, egy kis függvény javítása) 100%-os sikerarányt adott, így két variánst nem tud megkülönböztetni. A `hard-1` öt feladata ugyanolyan szerkezetű (leírás a `README.md`-ben, hibás kiinduló kód, **a munkamappán kívüli rejtett ellenőrzés**), de szándékosan nehezebb: sok szélsőséges eset, kétértelműséget nem tartalmazó, de pontos leírás, és olyan csapdák, amelyeket egy gyors megoldás elnéz.

| Feladat | Mit kér | Mi a nehéz benne (a leírás mindent kimond, az ellenőrzés mindent számon kér) |
|---|---|---|
| `interval-merge` | zárt intervallumok összevonása | a bemenet nem módosítható (befagyasztott bemenet is), a "érintkezik" és "átfed" különbsége (`touching`), a tartalmazott intervallum, a hibaosztály (`RangeError` vagy `TypeError`) és az egész bemenet előzetes ellenőrzése |
| `csv-parse` | CSV-elemző | idézőjeles mezők és `""`, sortörés az idézőjelben (`\n`, `\r\n`, `\r`), üres sor, záró sortörés, BOM, `SyntaxError` pontos sorszámmal (az idézőjelen belüli sortörésekkel is) |
| `money-split` | összeg elosztása súlyok szerint | pontos számítás (0,1 + 0,2 + 0,7 nem lehet lebegőpontos hibás), legnagyobb maradék módszer, döntetlennél az alacsonyabb index, negatív összeg, nincs `-0`, `Number.MAX_SAFE_INTEGER`-ig működik |
| `rate-limiter` | csúszóablakos limitáló | félig nyitott ablak (a pontosan `windowMs`-sel korábbi esemény már nem számít), csak az engedett kérést naplózza, `retryAfterMs`, `size()` és a kulcsok felejtése időzítő nélkül |
| `iso-weeks` | ISO 8601 hetek három modulban | az év eleji és év végi napok, a 53 hetes évek, a hetek éve eltérhet a naptári évtől; a hibát két fájlban is ki kell javítani (a `dates.js` és a `report.js`), a `calendar.js`-t pedig újraírni |

- **A készlet önellenőrző** (`src/__tests__/eval-tasks.test.ts`): minden feladatnál a hibás kiinduló kódon az ellenőrzésnek **buknia** kell, a referenciamegoldással **át kell mennie** (a referenciamegoldások az `eval/hard-1/reference` mappában vannak, az ügynök munkamappájába nem kerülnek). Ez kizárja a lehetetlen vagy téves feladatot. A validáció közben ki is derült egy hiba: a `delimiter: null` esetét a leírás nem rögzítette, de az ellenőrzés számon kérte, ezt kivettük (kétértelmű esetet nem kérünk számon).
- **A rejtett ellenőrzések a készlet mappájában vannak**, a `check` és a `setup` mezőben a `{setDir}` a készletfájl mappáját jelenti. A készletet így bárhová át lehet másolni, a projekten belülre kell kerülnie (a `setup` a projekten belül marad).
- **A sikerarány még nem mért.** Hogy ezek a feladatok a 30–70%-os sávba esnek-e, csak egy kalibráló futás mutatja meg (a Claude Code alapbeállításával, Bash nélkül: az ügynök a kódot nem tudja futtatni, csak olvasni és szerkeszteni). Ha egy feladat mindig sikeres vagy soha, a készletből ki kell venni vagy át kell írni.
- **Korlát:** öt feladat, egy szerző (a feladatok, a referenciák és az ellenőrzések is tőlem származnak), és mindegyik tiszta, egy modulos függvény. Valódi, nagyobb kódbázison végzett munkát (több fájl, függőségek, tesztfuttatás) ez nem képvisel.

## Kalibráló futás a `hard-1` készleten (2026-11-18)

Két variáns, mindkettő 5 feladat × 3 ismétlés = 15 futás, ugyanaz a beállítás (`claude -p`, `acceptEdits`, a `Bash` tiltva, futásonként legfeljebb 0,5 USD-egyenérték). **A**: a `claude` alapértelmezett modellje (a futás idején a modellnevet még nem rögzítettük). **H**: `--model haiku`, a host saját használati jelentése szerint `claude-haiku-5-5` (ez a host állítása, nem független ellenőrzés).

| Feladat | A: siker | A: becsült költség/futás | H: siker (eredeti ellenőrzés) | H: becsült költség/futás |
|---|---|---|---|---|
| `interval-merge` | 3 / 3 | 0,10–0,20 | 2 / 3 | 0,007–0,012 |
| `csv-parse` | 3 / 3 | 0,14–0,16 | 3 / 3 | 0,010–0,017 |
| `money-split` | 3 / 3 | 0,11–0,12 | 3 / 3 | 0,010–0,013 |
| `rate-limiter` | 3 / 3 | 0,11 | 3 / 3 | 0,012 |
| `iso-weeks` | 3 / 3 | 0,14–0,15 | 3 / 3 | 0,011–0,017 |
| **Összesen** | **15 / 15** | átlag 0,13, összesen 1,96 | **14 / 15** | átlag 0,012, összesen 0,18 |

(A költségek API-egyenértékű becslések USD-ben, lásd a Költségterv elejét. A két futás együtt kb. 2,1 USD-egyenérték a Pro-keretből.) A futások sebessége: A 16–41 s, 4–13 kör; H 17–63 s, 5–16 kör.

- **Mindkét modell eléri a plafont.** Az A 15 / 15, a H 14 / 15, és az egyetlen bukás a feladat hibája volt (lásd lent), a kijavított ellenőrzéssel a H is 15 / 15. A gyengébb modell tehát **nem ad fejteret**, a készlet két variánst nem tud megkülönböztetni. Egy 100%-os alapon csak **romlás** mutatható ki (például 9 / 15 a 15 / 15-tel szemben, Fisher p ≈ 0,01), javulás nem. A készlet ezért **regressziós ellenőrzésnek** jó: ha egy profil- vagy vitamód-változtatás után a sikerarány leesik, az jelzés.
- **A gyengébb modell kb. tizedannyiba kerül** (0,012 és 0,13 USD-egyenérték futásonként), de ugyanazokat a feladatokat oldja meg. Az eval-keret költségtervéhez: egy 90 futásos variáns kb. 1 USD-egyenérték a gyengébb és kb. 12 az alapmodellel.
- **A bukás oka kétértelműség volt.** Az `interval-merge` egyik futása `touching: false` mellett a `[2,2]`-t a `[2,2]`-be és a `[5,5]`-öt az `[1,5]`-be olvasztotta ("az intervallum a másikon belül eltűnik"). A leírásom azt is mondja, hogy a `touching: false` csak "egynél több pontban átfedőket" von össze, és egy pont a másik intervallum végén mindkét szabályra illik, tehát a leírás **nem döntötte el**. A két esetet az ellenőrzésből kivettük, a H futás a kijavított ellenőrzéssel átmegy (kézi újraértékelés a munkamappán; a tárolt sor az eredeti ítéletet őrzi). **Tanulság:** a kétértelműséget a referenciamegoldás-ellenőrzés nem fogja meg (a referencia a szerző olvasatát követi), két különböző modell eltérő olvasata viszont jelzi.
- **Nem csalt, amit ellenőrizni tudtam:** mind a 30 munkamappában a `README.md` változatlan, csak a `src/` fájlok módosultak, a megoldásokban nincs hivatkozás a rejtett ellenőrzésekre. A `permission_denials` mezőt a futtató nem rögzíti.
- **Új: a `model` mező.** A futtató a host használati jelentéséből (`modelUsage` kulcsai) kiolvassa a modellnevet, az `eval check` és `eval record` rögzíti (`--model`), és a `report` variánsonként mutatja. Ez a host állítása, nem ellenőrzött, de a következő kísérleteknél látni lehet, hogy a variáns tényleg azon a modellen futott-e.
- **Következő lépések (nincsenek megvalósítva):** (1) egy **negatív kontroll**: egy szándékosan rontott variáns (például túl kicsi költségkorláttal, hogy a futások korán megszakadjanak), hogy lássuk, a mérőeszköz **észleli-e a romlást**; (2) **nagyobb vagy pontatlanabb leírású feladatok**, ahol a követelmény egy részét a meglévő kódból és tesztekből kell kitalálni, és ahol az ellenőrzés mégsem igazságtalan.

### Számlálómérés: 15 haiku-futás a keret százalékában (2026-11-18)

A Pro-előfizetés 5 órás használati számlálóját a claude.ai használati oldalán olvastuk le a mérés előtt és után. Egyetlen köteg: a `hard-1` készlet 15 új futása a `claude-haiku-5-5` modellel (a futtató kimenete szerint), 5 feladat × 3 ismétlés, 15/15 sikeres, API-egyenértékű becsült költség **0,246 USD**.

| Mérés | Számláló |
|---|---|
| Előtte (modellváltás után, nincs futó eval) | 0% |
| Utána (a 15 futás után) | 6% |

- **Ebből becsült arány:** 6 százalékpont / 0,246 USD-egyenérték ≈ **0,04 USD-egyenérték százalékpontonként**, felső becslésként, mert a beszélgetés saját fogyasztása (a mérés közben írt üzenetek és olvasások) nincs levonva, és a számláló egész százalékot mutat (±1 pont).
- **Következmény a tervezéshez:** egy 90 futásos haiku-variáns (kb. 0,016 USD-egyenérték/futás, ez 1,5 USD-egyenérték) a becslés szerint **kb. 35–40 százalékpont**. Egy alapmodelles variáns (kb. 0,13 USD-egyenérték/futás) ennek sokszorosát fogyasztja. A kísérleteket ezért a keret százalékában érdemes tervezni, nem USD-egyenértékben.
- **Nem igazolt:** a beszélgetés többi részének fogyasztása (a számláló nem bontja szét), és az, hogy az arány más modellekre vagy más feladatokra is igaz-e. Egy tiszta mérés (üres beszélgetés, csak a köteg) pontosítaná.
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
- Mennyi egy **nehezebb** feladat költsége és szórása. Az eddigi két próbafeladat (apró, illetve kis hibajavítás) 0,09 és 0,14 USD közötti futásköltséget adott, de mindkettő túl könnyű volt a variánsok megkülönböztetéséhez.
- Mi a `--max-budget-usd` viselkedése, ha egy futás eléri: leáll-e tisztán, és mit ad vissza a kimenet.
- Körszám-korlát: van-e a használt verzióban erre mód (a 2.1.322 súgójában nincs `--max-turns`).
- Miért tér el a két futás költsége, és számít-e a gyorsítótár a mérésnél (azonos feladat ismétlése a gyorsítótár miatt olcsóbb lehet, ami torzítja az átlagot).
- Hány feladat elég ahhoz, hogy a kis készlet is mondjon valamit.
- A Cowork alatt futtatható-e a futtató szkript, vagy csak a Claude Code CLI-ben.
- A `debate` mező (váltások, hipotézisek) rögzítése a futásoknál még nincs megvalósítva.
- A `tune` és `holdout` szétválasztását a `split` mező csak rögzíti, a rendszer nem kényszeríti.
