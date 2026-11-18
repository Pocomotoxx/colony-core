# Irány: honnan indultunk, hol tartunk, mi kell a céléhez

Állapot: 2026-11-18. Ez a dokumentum az összefogó irányt rögzíti. A részletek a tervekben vannak (`ROADMAP.md`, `docs/SYSTEM-OVERVIEW.md`, és a többi terv).

## 1. Honnan indultunk

- A projekt egy korábbi, nagyobb rajalapú rendszerből (Kristalplus) indult. Az volt a feladat, hogy ezt egy **fejlesztő tanuló AI-társává** alakítsuk.
- A tisztítás után a név **Colony**, a repó `colony-core`, a nyilvános `main` ágon. A ruflo és ruvnet hivatkozások eltávolítva, az előzmények a régi repóban maradtak.
- Az irány az **A variáns** lett: egy fejlesztő, egy munkamenet (Claude Code). A Colony **emlékezet, őr és ellenőrzés** a munka körül, nem önálló ügynök-raj.
- A kulcs elv: **csak azt állítjuk, amit igazolni tudunk.** Minden fázisnak mérhető kilépési feltétele van.

## 2. Hol tartunk

| Terület | Állapot | Mit mutat |
|---|---|---|
| 0. fázis: használható | **kész** | `start`, felidézés, őr, bizonyíték-rögzítés, audit |
| **1. fázis: megmérni, ér-e valamit** | **nincs kész** | a felidézés hasznosságát nem mértük, nincs 30 értékelt munkamenet |
| 2. fázis: keresés valós adaton | nincs kész | a keresés helyi n-gram, nem jelentésalapú |
| 3. fázis: megbízhatóság | részben | teszt-lefedettség, CI, de nincs hosszú távú használati adat |
| Eval-keret | kész, mért | a `hard-1` készlet plafonon van (15/15), regressziós ellenőrzésnek jó |
| Radar | kész, mért | valódi adaton 0 téves jelzés, a jelkeresés 5/5 megnevezett projekt |
| Védelem (Groq, helyi szűrő) | részben, kitalált mintákon | beágyazott támadások: a Guard gyenge, a szabályok optimisták |
| Cowork-integráció | **nem igazolt** | a `start` parancs megvan, de nem tudjuk, hogy a Cowork futtatja-e |

**Ahol elkanyarodtunk:** az utóbbi hetekben a munka nagy része **mellékágakra** ment: radar, Groq-kísérletek, eval-keret, motívum- és koordinátor-tervek. Ezek mind hasznosak lehetnek, de **az 1. fázis (a saját munkádon mérés) nem történt meg**. Nem tudjuk, hogy a felidézés segít-e a munkában, és ez a legfontosabb kérdés. A mellékágak a mérés előtt túl sok készültek.

## 3. Mi a cél

**Rövid távon (1. fázis kilépése):** a fejlesztő (te) a saját munkáján használja a Colony-t, és **értékeli** a felidézéseket. Kilépési feltétel: legalább **30 értékelt munkamenet**, és a hasznosság mérhető. 50% alatt nem bővítjük a felidézést, hanem megvizsgáljuk az okát.

**Hosszabb távon:** egy fejlesztő, aki a Colony-val mérhetően kevesebb hibát vagy gyorsabb munkát ér el, és tudja, mikor bízhat a rendszer válaszában és mikor nem.

## 4. Mi kell a céléhez

1. **Használat a saját munkán.** Ez a hiányzó láncszem. Nélküle minden további fejlesztés becslés marad.
2. **Értékelési szokás.** Minden munkamenet végén egy rövid értékelés (hasznos / nem hasznos, a felidézett elemekre), és ezt a rendszer rögzíti. Erre a `recall list`, `recall rate` és `recall stats` parancsok szolgálnak; a használat mérése (30 értékelt munkamenet) még hátra van.
3. **Hasznosság mérése:** a rögzített értékelésekből a felidézés aránya, és az, hogy a segített munkamenetek többet vagy kevesebbet hibáznak-e.
4. **Mellékágak befagyasztása** az 1. fázis végéig: új radar-, eval- vagy védelmi szolgáltatások nem indulnak, amíg nincs mérés. A `ROADMAP.md` ezt már kimondja.
5. **Cowork-ellenőrzés:** ha a Cowork a fő környezeted, egyszer ki kell próbálni, hogy a `start` és a hookok futnak-e benne.

## 5. Javasolt következő lépések (sorrendben)

1. **Ezt a dokumentumot elfogadni** (vagy módosítani): ha egyetértesz, a mellékágak befagyasztása dől el.
2. **A felidézések értékelése** (`recall list`, `recall rate`, `recall stats`): kész, tesztekkel (PR #24). Ez volt az 1. fázis előfeltétele.
3. **Használat:** 30 munkamenet a saját munkádon, minden munkamenet végén értékelve.
4. **Összesítés:** a hasznosság aránya és a hibák összehasonlítása. Csak ez után dől el, mi jön a 2. fázisból.

## 6. Amit nem állítunk

- Nem bizonyítottuk, hogy a Colony javítja a munkát.
- A felidézés hasznosságáról nincs mérésünk.
- A védelem nem teljes, a radar és a Groq-kísérletek kitalált vagy kis mintákon mértek.
- A költség API-egyenérték becslés, nem számla.
