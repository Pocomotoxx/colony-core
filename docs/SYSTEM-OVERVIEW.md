# Colony: összefoglaló, erősségek, lehetőségek

Állapot: 2026-11-18, a `main` ágon. Minden állítás mellett jelölve, hogy **mérés** vagy **teszt** igazolja-e, vagy csak **terv**. Ahol a mérés kicsi vagy a feladatokat a szerző írta, ott ezt is kimondjuk.

## Mi a Colony

Egyfejlesztős segédeszköz egy AI-kódolóasszisztens (elsőként a Claude Code) munkája mellé. Nem hív modellt: a gazdagép (host) a modell, a Colony a főkönyv, az őr, az ellenőrzés és az emlékezet. Helyben fut, nulla futásidejű függőséggel, hálózat nélkül a magban.

## Erősségek

### 1. Megfigyelt bizonyíték, nem a modell állítása
- **Teszt:** a `verify` parancsot a Colony futtatja, és a hibás eredmény csökkenti a minőséget (0,3-ra korlátozza). A Claude Code hookja megfigyeli a futtatott ellenőrzéseket is.
- **Teszt:** a megbízhatatlan alakok (csővezeték, `|| true`) nem számítanak bizonyítéknak.

### 2. Őr a veszélyes műveletekre
- **Teszt és élő használat (Claude Code 2.1.281):** a hook megtagadja az állapotmappa, a `.git` és a hook-beállítások módosítását, a romboló és kódfuttató parancsokat. Az útvonalakat feloldja (`cd`, `..`, abszolút útvonal, kis- és nagybetű).
- **Korlát:** szöveges szabályok. Egy kreatív parancs elkerülheti. A hook a védelem egyik rétege, nem homokozó.

### 3. Hash-láncolt audit és integritás
- **Teszt:** minden lényeges esemény az audit-naplóba kerül, a lánc ellenőrizhető (`audit verify`), a sérülés észrevehető.
- **Korlát:** az integritásrekord aláíratlan; aki a fájlokhoz hozzáfér, újra tudja számolni.

### 4. Feladatkezelés, szavazás, vita
- **Teszt:** feladatok, függőségek, felülvizsgálati körök korláttal, `hold`, konszenzus négy kvórumstratégiával, és egy szerepenként két vitamóddal rendelkező vitarendszer. A különvélemény (`dissenter`) szavazat nélkül kerül rögzítésre, a hipotézis jóslatot és próbát kér.
- **Korlát:** az ügynökök szerepe szöveg. A rendszer rögzíti és kényszeríti a módot, de nem tudja ellenőrizni, valóban úgy érveltek-e.

### 5. Emlékezet, de nem tudás
- **Teszt:** helyi, determinisztikus n-gram vektoros keresés, a Reasoning Bank csak értékelt munkából tanul.
- **Mérés:** nincs. Hogy a felidézés segít-e a munkában, **nem mértük**. Ez a legfontosabb nyitott kérdés.

### 6. Eval-keret: mérni, mielőtt bevezetünk
- **Teszt:** feladatkészlet objektív ellenőrzéssel, futtató (`scripts/eval-run.mjs`) kötelező becsléssel, költségkerettel, időkorláttal, és Fisher-féle egzakt próbával, amely csak elég futás és zajon kívüli különbség esetén nevez nyertest.
- **Mérés:**
  - `hard-1` (5 feladat, 3 ismétlés): az alapmodell 15/15, a Haiku 15/15 (egy kétértelmű ellenőrzés javítása után; előtte 14/15).
  - Plafonhatás: a készlet **regressziós ellenőrzésnek** jó (romlást mutat), javulást nem.
  - Költség: a Haiku futásonként kb. 0,012, az alapmodell kb. 0,13 API-egyenérték USD; ez Pro-előfizetéssel a használati keretből fogy.
  - Számláló: 15 Haiku-futás ≈ 6 százalékpont (felső becslés, ±1 pont).

### 7. Külső szövegek: a radar és az őrzés láncolata
- **Mérés (valódi adat):** 25 kiadási jegyzet 5 tárolóból (és később 16 a 4 javasolt tárolóból): 0 gyanús, 0 hostile, 0 téves karantén.
- **Mérés (kitalált minták):**
  - Helyi szűrő, az olvasó modellhez szóló beágyazott támadásokra a szabálybővítés után: 12/14 és 15/16 jelzése (korábban 1/14 és 1/16). Ez **optimista**: a szabályokat és a mintákat ugyanaz a szerző írta.
  - Groq Prompt Guard: 0,5-ös küszöbnél 6/14 és 3/16 támadás. A beágyazott támadásokat nem fogja meg; a 0,01-es küszöb a második készleten nem általánosított. A küszöb marad 0,5, a Guard kiegészítő jelzés.
- **Láncolat:** saját függőségekből forráslista (hálózat nélkül, név szerinti jóváhagyással), letöltés (csak a jóváhagyott feedek, átirányítás nélkül, méret- és időkorláttal), kor szerinti szűrés, Guard és kivonat (zárt hibával), import (újraszűréssel, lejárattal, a lejártak törlésével), és `next`/`start` kimenetben címkézett jelek.

### 8. Biztonsági részletek, amelyek valódi hibákból jöttek
- A hibaüzenetek kiírása nélkül egy hiba oka nem derült volna ki (HTTP 400: a Guard bemeneti korlátja). A darabolás most adaptív.
- A verziószámok kitakarása IP-címnek nézte őket: most a kitakarás szűk, opt-in kihagyást kap, a titkok soha nem.
- A jelkeresés hasonlósági küszöbe nem választotta szét a releváns és az irreleváns feladatokat: a projektnév alapú találat ezt javította (5/5 megnevezett projekt, 2/3 üres eredmény az irrelevánsoknál).

## Lehetőségek (amit a rendszer már tud, és amit a dokumentum szerint még lehet)

| Lehetőség | Állapot |
|---|---|
| Felidézés, amely a munkát segíti | **nem mértük** (a legfontosabb nyitott kérdés) |
| Negatív kontroll az eval-hez (szándékosan rontott variáns, hogy a mérőeszköz észrevegye a romlást) | terv |
| Nagyobb vagy pontatlanabb leírású eval-feladatok (a követelmény egy része a kódból jön) | terv |
| A radar jelküszöbének kalibrálása külső, valódi szövegen | terv |
| Cowork-integráció (`AGENTS.md`, `.claude/commands`, hookok a Cowork alatt) | **nem igazolt** |
| A `start` kimenete a teljes rendszerrel együtt, bilingvális CLI-üzenetek | részben (dokumentáció kétnyelvű, a CLI nem) |
| Tárolás, felejtés, a naplófej rögzítése gitben | terv |
| Motívumok (újrahasznosítható munkafolyamat-sablonok) | terv, nincs kód |

## Amit nem állítunk

- **Nem bizonyítottuk, hogy a Colony javítja a munkát.** Csak azt, hogy a mérőeszközök működnek és a mért számok a leírtak.
- **Nem hitelesít személyt vagy szereplőt.** A `--as` nevek szövegek.
- **Nem védi a modellt a beágyazott utasításoktól.** A védelem rétegezett, de nem teljes.
- **A tesztfeladatok és a kitalált minták szerzője egy ember (és az asszisztens).** Az arányok nem általános hibaarányok.
- **A költség API-egyenérték becslés,** nem számla; Pro-előfizetéssel a használati keret fogy.
- **Nem tesztelt Cowork-környezetben.** A Claude Code CLI-ben igen.

## Ajánlott következő lépések

1. **Felidézés mérése:** ugyanazok a feladatok felidézéssel és anélkül, valódi munkamenetekből. Ez dönti el, hogy a rendszer értéket ad-e.
2. **Negatív kontroll** az eval-hez, hogy a mérőeszköz érzékenysége ismert legyen.
3. **Függetlenebb minták** a védelemhez: nem a szerző írta, és valódi, külső forrásból származnak.
4. **Cowork-ellenőrzés** a `start` parancsnak, ha a Cowork a fő környezet.
