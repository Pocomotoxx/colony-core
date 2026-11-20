# Colony: összefoglaló, erősségek, lehetőségek

Állapot: 2026-11-18, a `main` ágon. Minden állítás mellett jelölve, hogy **mérés** vagy **teszt** igazolja-e, vagy csak **terv**. Ahol a mérés kicsi vagy a feladatokat a szerző írta, ott ezt is kimondjuk.

## Mi a Colony

Egyfejlesztős segédeszköz egy AI-kódolóasszisztens (elsőként a Claude Code) munkája mellé. Nem hív modellt: a gazdagép (host) a modell, a Colony a főkönyv, az őr, az ellenőrzés és az emlékezet. Helyben fut, nulla futásidejű függőséggel, hálózat nélkül a magban.

## Erősségek

### 1. Megfigyelt bizonyíték, nem a modell állítása
- **Teszt:** a `verify` parancsot a Colony futtatja, és a hibás eredmény csökkenti a minőséget (0,3-ra korlátozza). A Claude Code hookja megfigyeli a futtatott ellenőrzéseket is.
- **Teszt:** a megbízhatatlan alakok (csővezeték, `|| true`) nem számítanak bizonyítéknak.

### 2. Őr a veszélyes műveletekre
- **Teszt és élő használat (Claude Code 2.1.281):** a hook megtagadja az állapotmappa és a `.git` módosítását, valamint a romboló és kódfuttató parancsokat; a hook-beállítások (`.claude/settings*.json`) módosításánál rákérdez (`ask`), mert azt a felhasználó engedheti. Az útvonalakat feloldja (`cd`, `..`, abszolút útvonal, kis- és nagybetű, a már létező symlink és junction). A titokfelismerésben a saját minták mellett a gitleaks v8.30.1 készlet (221 szabály) **figyelmeztet**, nem blokkol (a találatok a `.colony/ruleset-warnings.jsonl` fájlba kerülnek a hamis pozitívok megszámolásához). A parancsokra a Sigma `core` csomag 25 Linux és 350 Windows folyamatindítási szabálya **figyelmeztet** (támadói viselkedés: reverse shell, naplótörlés, shell indítása GTFOBin-eken át), nem blokkol; a figyelmeztetés a szabály szerzőjét is megnevezi, ahogy a licenc (DRL 1.1) kéri. A védett mappát a projekt gyökeréből számolja (a `.colony` keresése felfelé), nem a host aktuális könyvtárából.
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
- **Teszt:** feladatkészlet objektív ellenőrzéssel, futtató (`scripts/eval-run.mjs`): kötelező `--yes` és költségkeret (a keret leállítás, nem plafon: az első futás átléphet, utána a legdrágább eddigi futás alapján nem indít olyat, amely valószínűleg átlépné; a keret hívásonként érvényes), host-időkorlát (POSIX-on a teljes folyamatcsoportra); a becslés (`--dry-run`) nem kötelező; és Fisher-féle egzakt próbával, amely csak elég futás és zajon kívüli különbség esetén nevez nyertest.
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

## Ismert korlátok (külső audit, 2026-11-18)

Az auditból ezek maradtak szándékosan megoldatlanul, vagy csak dokumentálva:

- A nagybetűs `.GIT/…` útvonalat az őr Linuxon is tiltja (a nevet kisbetűsítve hasonlítja): túlvédés, nem megkerülés.
- A radar-import a fájl `status: ok` és Guard-pontszám állítását nem tudja ellenőrizni. A helyi átvizsgálás újra lefut, a gyanús tétel "unverified" címkével kerül a memóriába.
- A radar útvonalán a valódi IPv4-címek megmaradnak (a verziószámok megőrzése miatt: a `skip: ['ip_address']` csak az IPv4 alakra vonatkozik). Az IPv6 címet a kitakarás a presidio-készlettel eltünteti, a `::1` loopback kivételével.
- A szűrő az idézett támadómondatot tartalmazó oktatási szöveget `hostile`-nak minősíti (hamis pozitív).
- Az eval-futtató a hostot nem zárja homokozóba: a munkamappa csak kezdőkönyvtár, a host a felhasználó jogaival fut, és a környezetét örökli.
- A mentés három külön fájlt ír (főkönyv, audit, integritásrekord). Egy megszakadás utáni boot BLOCKED, nem csendes; `--accept-changes` kell hozzá.
- Hiányzó integritásrekord: a régi (a rekord bevezetése előtti) állapot és a törölt rekord megkülönböztethetetlen. A boot nem blokkol (a régi állapot támogatott), de `notes` mezőben szól, és a következő mentés új rekordot ír: aki törli a rekordot, így kapcsolja ki az ellenőrzést a következő bootig. A sérült rekord viszont blokkol.
- Az eval tárolt `passed` értéke a colony ellenőrzésének eredménye akkor is, ha a host hibázott; a `hostStatus` mező külön rögzíti, hogyan ért véget.
- A Sigma-szabályok mind `test` állapotúak (nincs köztük `stable`), a parancs leképezése (az `Image` a program neve elé írt `/usr/bin/`) feltevés, és a szülőfolyamatot vagy felhasználót kérő 6 szabály kimarad. A Windows-szabályok (`sigma-windows`) ugyanígy csak figyelmeztetnek; a PowerShell-eszköz parancsát a `powershell.exe` eseményeként is megvizsgálják, de a Windows-leképezés feltevés (az `OriginalFileName` a program fájlneve, a gazdafolyamat `powershell.exe -Command <parancs>`), és 208 szabály kimarad (szülőfolyamat, felhasználó, hash). A saját mérésünk 51 szokásos parancson 0 találatot adott, 29 támadó-szerű parancsból 15-öt jelzett. A `sigma-powershell` készlet (53 PowerShell-szkriptblokk szabály) a PowerShell-eszköz parancsát, a `powershell -Command` utáni szöveget és a `-EncodedCommand` megfejtett szövegét vizsgálja; 25 szokásos szkripten 0 találatot adott, 16 támadó-szerűből 9-et jelzett. A `sigma-registry` készlet (117 rendszerleíró-szabály) a `reg add`/`reg delete` és a `Set-`/`New-`/`Remove-ItemProperty` parancsokból épít Sysmon-szerű eseményt; 15 szokásos parancson 0 találatot adott, 14 támadó-szerűből 6-ot jelzett. A `reg import`-ot, a szkriptfájlokat és a futáskor épülő útvonalakat nem látja. A `sigma-file` készlet (86 fájl-szabály) a parancsok fájlírásaiból (átirányítás, `Out-File`, `Set-Content`, `copy`, letöltés `-OutFile`/`-o` kapcsolóval, `certutil`, `bitsadmin`) és törléseiből, valamint a Write/Edit eszköz útvonalából épít Sysmon-szerű eseményt; 26 szokásos parancson és 10 szokásos Write-útvonalon 0 találatot adott, 18 támadó-szerű parancsból 6-ot jelzett. Az írt tartalmat, a szkriptfájlokat és a futáskor épülő útvonalakat nem látja.
- A promptinjekciós szűrő saját szabályokra épül. Az ATR (MIT) szabályait megmértük, nem vettük át: a 30 támadásunkból 5-öt fogtak meg (a saját szűrő 24-et), a `stable` szabályaik egyet sem; a két rendszer más fenyegetési modellre készült (a docs/RULESETS-PLAN.md 6/f).
