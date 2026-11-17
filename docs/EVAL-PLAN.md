# Eval terv: az ügynökök pontosítása méréssel, költségkerettel

Állapot: **terv, nincs megvalósítva.** Ami nincs igazolva, azt a "Nyitott kérdések" fejezet sorolja fel.

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
| `costUsd`, `inputTokens`, `outputTokens`, `durationMs` | amit a futtató a hosttól kap |
| `turns` | a körök száma |
| `debate` | váltások és hipotézisek (a `debate stats` adataiból) |

## Parancsok (tervezett)

| Parancs | Mit csinál |
|---|---|
| `eval estimate --set S --variants A,B --repeats N` | Becsli a költséget és az időt, nem futtat semmit. |
| `eval record ...` | A futtató ezzel rögzíti egy futás eredményét. |
| `eval compare --set S --variants A,B` | Variánsonként sikerarány, szórás, költség, és hogy a különbség a zajnál nagyobb-e. |
| `eval report` | Összegzés a jóváhagyáshoz. |

A futtató szkript (`scripts/eval-run.mjs`): tiszta mappába másolja a feladatot, a hoston lefuttatja a variánst, az ellenőrző parancsot maga futtatja le, és `eval record`-dal rögzíti az eredményt.

## Költségterv

### Képlet

```
költség = feladatok × ismétlések × variánsok × átlagos futásköltség
```

Az átlagos futásköltséget **nem találom ki**: a próbafutás méri meg.

### Kemény keretek

| Keret | Alapérték (javaslat) | Hatása |
|---|---|---|
| Futásonkénti körszám | 15 | a futás leáll, sikertelennek számít |
| Futásonkénti idő | a feladat `timeoutSec` értéke | ugyanígy |
| Futásonkénti költség | a próbafutás átlagának 3-szorosa | ugyanígy |
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

- A `claude -p` kimenete tartalmaz-e költség- és tokenadatot, és van-e költségkeret-kapcsoló a használt verzióban. A próbafutás dönti el.
- A Cowork alatt futtatható-e a futtató szkript, vagy csak a Claude Code CLI-ben.
- Mennyi egy valós feladat átlagos költsége és szórása.
- Hány feladat elég ahhoz, hogy a kis készlet is mondjon valamit.
