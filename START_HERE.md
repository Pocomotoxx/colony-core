# Start Here

A Colony semmilyen LLM-szolgáltatót nem hív: a host (például a Cowork) maga a modell. Az indításhoz egyetlen utasítás kell, amit feladatadáskor a hostnak adsz. A hostra semmi mást nem kell telepíteni, csak Node.js 20+ és pnpm.

## Alap utasítás

Másold be a hostnak, és a végén cseréld ki a **[FELADAT]** részt:

> A `Pocomotoxx/colony-core` GitHub-repót használd. Ha a `dist/cli.js` még nincs meg, fordítsd le: `pnpm install && pnpm build`.
> Futtasd a `node dist/cli.js boot --dir <projektmappa>` parancsot, és olvasd el teljes egészében a kimenetben kapott szabályokat. Csak akkor kezdj dolgozni, ha a boot állapota `LOADED` vagy `UNVERIFIABLE`. `BLOCKED` esetén állj meg, és jelentsd a pontos hibát.
> A feladatot a `task add` paranccsal vedd fel, a `next --as <szerep>` paranccsal kérd le, és `done --result` vagy `fail --error` paranccsal zárd le. Az eredményt ne találd ki: csak azt írd le, amit ténylegesen megtettél és ellenőriztél.
> Feladat: **[FELADAT]**

## Rövid utasítás

> Colony mód. A `Pocomotoxx/colony-core` repóban fordítsd le a csomagot (`pnpm install && pnpm build`), futtasd a `boot` parancsot a projektmappára, olvasd el a szabályokat, és csak utána dolgozz. Feladat: **[FELADAT]**

## Tudnivalók

- A `<projektmappa>` az a mappa, amelyben a munka folyik. Az állapot (`.colony/`) és a szabályok (`.colony/rules/`) oda kerülnek, az első boot létrehozza őket. A parancsok az eszköz mappájától függetlenül futnak.
- A boot kimenete tartalmazza a szabályok szövegét. Ha boot után bármelyik szabályfájl megváltozik, a parancsok 2-es kóddal megállnak, és újra kell bootolni.
- A boot azt bizonyítja, hogy az állapot és a szabályok be lettek olvasva. Azt nem, hogy a host alkalmazta is őket.
- A parancsok teljes listája és a boot állapotai: [README.md](README.md).
