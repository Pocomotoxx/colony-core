# Kész szabálykészletekre épülő szabálymag: terv

**Állapot: az 1. szelet építése folyik. Kész: a gitleaks v8.30.1 átvétele, a szigorú TOML-olvasó, a Go-regex átalakító, a hash-ellenőrző betöltő, a kereső és a mérőszkript. Még nincs bekötve: a `findSecretSpans` és a kitakarás a régi saját mintákat használja, a rendszer a mérés után vált.** Az irányt a fejlesztő kérte (2026-11-19): a Colony szabálymagja ne csak kézzel írt szabályokból álljon, hanem már létező, karbantartott, nyílt szabálykészletekre támaszkodjon, verzióval, forrással és hash-sel rögzítve. Saját szabályok később is lehetnek mellette.

## 1. Miért

A mostani szabályok mind kézzel írtak, forrás és verzió nélkül. A titokfelismerés például 8 minta a `src/gates.ts`-ben (általános kulcs-, jelszó- és token-értékadás, privát kulcs, `sk-`, GitHub, npm és AWS kulcs). Egy karbantartott készlet több száz szolgáltató kulcsformátumát ismeri, és mások már megtalálták a hibáit. A külső audit is a kézzel írt szabályoknál talált tévedést (hamis pozitív, kimaradó minta).

Ez nem jelenti azt, hogy egy külső szabálykészlet automatikusan jobb: a minőségét a saját mintáinkon mérjük, mielőtt átállunk (lásd a 6. pontot).

## 2. Jelöltek (a licencet és az aktivitást 2026-11-19-én a GitHub adatai szerint néztem meg)

A licenc oszlop a GitHub licencmezője. A jogi szöveget nem olvastam el készletenként, és a szabályok minőségét nem ellenőriztem.

| Készlet | Licenc | Állapot | Mire jó nekünk | Döntés |
|---|---|---|---|---|
| **gitleaks** (`config/gitleaks.toml`) | MIT | aktív, legutóbbi kiadás v8.30.1 (2026-03-21) | titokminták: egy fájl, szabályonként azonosító, regex, kulcsszavak, entrópia, kivételek | **1. szelet** |
| secretlint | MIT | aktív | TypeScript szabálycsomagok titkokra | tartalék, ha a gitleaks regexei nem vihetők át |
| detect-secrets | Apache-2.0 | aktív (utolsó változás 2026-04) | Python, pluginok | nem kell, a gitleaks fedi |
| presidio | MIT | aktív | személyes adatok felismerői (e-mail, kártya, IBAN, telefon, IP) | **2. szelet** (a kitakaráshoz) |
| garak (NVIDIA) | Apache-2.0 | aktív | LLM-sebezhetőségi próbák (promptinjekció is) | **tesztkorpusz**, nem szabály |
| vigil-llm | Apache-2.0 | utolsó változás 2024-01 | promptinjekciós szabályok | elavult, nem vesszük át |
| llm-guard | MIT | **archivált** | szkennerek | nem vesszük át |
| secrets-patterns-db | CC-BY-SA-4.0 | aktív | titokminták | **kerülendő**: a „share-alike" feltétel a belőle készült művekre is vonatkozhat, jogi átnézés nélkül nem |
| Sigma | a repón „nincs megállapítva" | aktív | naplóészlelési szabályok (Linux folyamatindítás) | a licenc (szabályokra külön) tisztázandó, a 3. szelet jelöltje |
| semgrep-rules | a repón „nincs megállapítva" (saját szabálylicenc) | aktív | kódminták | **kizárva** |
| trufflehog | AGPL-3.0 | aktív | titokkereső | **kizárva** (erős copyleft) |

**Ami nincs:** a veszélyes parancsokra és a promptinjekcióra nem találtam egyetlen, széles körben elfogadott, karbantartott, szabadon átvehető szabálykészletet. Ezeknél nem állítjuk, hogy van, lásd a 7. pontot.

## 3. Felépítés

A mag továbbra sem hív hálózatot és nem kap futásidejű függőséget. A szabálykészletek **a repóban vannak**, a futás helyi fájlokat olvas.

```text
rulesets/
  gitleaks/
    PROVENANCE.json     eredet, verzió, hash-ek
    LICENSE             az upstream licenc szövege, változtatás nélkül
    source/gitleaks.toml   az upstream fájl, bájtra azonos
    ruleset.json        a normalizált szabályok (ezt tölti be a mag)
  own/
    ruleset.json        a saját szabályaink, ugyanebben a formátumban
```

`PROVENANCE.json`: név, forrás-URL, a kiadás címkéje és a commit, licenc (SPDX) és a licencfájl hash-e, a letöltés ideje, az eredeti fájl SHA-256 hash-e, a normalizált fájl SHA-256 hash-e, az átalakító neve és verziója, a kihagyott szabályok listája indokkal.

**Hitelesség.** A letöltés a rögzített címkén történik. A letöltött bájtok git-blob hash-ét összevetjük azzal, amit a GitHub a címkézett fájlra mond. Ez azt bizonyítja, hogy a fájl az upstream repó adott verziója, nem azt, hogy a szabályok jók.

**Betöltés.** A mag minden indításkor ellenőrzi a `ruleset.json` hash-ét a `PROVENANCE.json`-nal. Eltérésnél **az a készlet nem töltődik be**, hangos figyelmeztetéssel, a saját szabályok és a beépített minimum marad. Nem hallgat el, és nem enged át csendben kevesebb védelmet.

**Átalakító.** A gitleaks szabályai Go (RE2) szintaxisúak, a mag JavaScriptet használ. Az átalakító szabályonként ellenőrzi, hogy a regex lefordul-e, és a kihagyottakat indokkal rögzíti. Nem állítjuk, hogy minden szabály átjön, a számot kimondjuk.

**Biztonság a regexekkel.** Az audit a regexek futásidejére is rákérdezett. Védelem: a szabály csak akkor fut, ha a kulcsszava szerepel a szövegben (a gitleaks is így csinálja), a bemenet hossza korlátos, és az átalakító egy gyors próbával kizárja a feltűnően lassú regexeket. Egy JS-regex futásideje nem korlátozható, ezért ez enyhítés, nem garancia.

**Találat.** A találat a készlet és a szabály azonosítóját, a helyet és a hosszt adja, az értéket sosem (ahogy ma is).

**Saját szabályok.** Ugyanabban a formátumban, a `rulesets/own/`-ban, a repóban verziózva. A mostani 8 titokminta ide költözik át, így nem vész el.

## 4. Frissítés

A `scripts/rulesets-update.mjs` (hálózatot használ, ezért külön szkript, kötelező `--yes`) a megadott címkéről letölt, ellenőrzi a hash-t, átalakít, és kiírja, mennyi szabály jött, tűnt el vagy változott. **Semmi nem frissül magától.** A változás egy külön PR, amit ember néz át, és a tesztek újra lefutnak.

## 5. Beillesztés

- `findSecretSpans` (`src/gates.ts`) és a kitakarás `secret` fajtája (`src/redact.ts`) a betöltött készletekből dolgozik, a saját szabályokkal együtt.
- A `secret` továbbra is mindig kitakarandó és nem kihagyható.
- A találatban megjelenik a készlet és a szabály azonosítója, a naplóban szabad szöveg továbbra sem.

## 6. Mérés az átállás előtt

Az átállásról mérés dönt, nem a készlet jó híre:

1. **Nem romolhat:** a mostani 8 minta eseteit az új készlet is megtalálja (kitalált tokenekkel, valódi kulcs soha).
2. **Hamis pozitívok:** a készlet találatait megszámoljuk a saját forrásunkon és a teszt- és dokumentumfájljainkon. A számot a fejlesztő látja, mielőtt az őr élesben blokkol vele.
3. **Sebesség:** a leghosszabb bemeneten és egy kontrollszövegen mérjük.
4. **Kipróbálás blokkolás nélkül:** az első kiadásban az új készlet találatai először csak jelzést adnak (`warn`), a blokkolás a mérés után kapcsol be.

## 6/a. Az első mérés (2026-11-19)

**Átalakítás:** a `gitleaks.toml` 222 szabályából **221 jött át**. Az egyetlen kihagyott a `pkcs12-file` (fájlnévre szóló szabály, mi szöveget vizsgálunk). Szabályok útvonal-kivételei (4 szabály, 4 kivétellista) elmaradnak, ami csak több találatot jelent. A regexek közül a mid-pattern `(?i)`, `(?-i:…)` és `(?s:…)` jelzős mintákat (22 szabály) kiírt kisbetű-nagybetű osztályokkal vittük át, mert a JavaScript Node 20-ban és 22-ben nem ismeri a hatókörös jelzőket.

**Kitalált példákon** (a tokenek egy rögzített generátorból jönnek, nem valódiak):

| Eset | Saját minta | gitleaks |
|---|---|---|
| API-kulcs értékadás, véletlen érték | talál | talál (`generic-api-key`) |
| API-kulcs értékadás, szó (`changeme-please`) | talál | **nem** |
| jelszó értékadás | talál | talál (`hashicorp-tf-password`) |
| token értékadás, véletlen érték | talál | talál |
| token értékadás, szó (`test-token`) | talál | **nem** |
| privát kulcs, csak a fejléc | talál | **nem** (a szabály törzset vár) |
| privát kulcs, teljes blokk (törzsével) | talál | talál (`private-key`) |
| `sk-` általános kulcs | talál | **nem** (csak a szolgáltatóra szabott formák) |
| GitHub-token, npm-token (kis- és nagybetűs), AWS-kulcsazonosító | talál | talál |

**A repó saját fájljain** (149 fájl: `src`, `docs`, `scripts`, a gyökér dokumentumai és a két Guard-készlet): a saját minták **7** találatot adtak, ebből 6 hamis pozitív (`token: 'test-token'`, egy teszt-jelszó), a gitleaks **2**-t (egy kitalált JWT egy tesztben, és egy `generic-api-key` találat, amelyet a saját minták is megtaláltak). Ezt egyetlen, kis, saját korpuszon mértük: az irányt mutatja, a gitleaks pontosságát nem bizonyítja.

**Amit ebből nem szabad kiolvasni:** hogy a gitleaks mindent megtalál. A mérés a mi példáinkra és a mi fájljainkra vonatkozik. A szavas (alacsony entrópiájú) értékadásokat a gitleaks szándékosan nem jelzi; ha ilyen jelzést is akarunk, az saját szabály lesz a `rulesets/own/`-ban.

**Sebesség:** mind a 221 regex lefut 20 000 karakteres, ismétlődő és kellemetlen bemeneteken 1,5 másodpercen belül (a teszt ezt őrzi); ez egy gyors próba, nem garancia.

## 7. Szeletek

| # | Szelet | Állapot |
|---|---|---|
| 1 | **Titokminták:** gitleaks v8.30.1 átvétele, betöltő, hash-ellenőrzés, átalakító, frissítő szkript, mérés, beillesztés | átvétel, átalakító, betöltő, kereső, mérés **kész**; a frissítő szkript (hálózat) és a beillesztés hátra van |
| 2 | **Személyes adatok:** a presidio felismerőinek átvétele a kitakaráshoz (a magyar adószám, TAJ és bankszámla marad saját) | ellenőrizendő: a regexek hordozhatósága, a licencfájl |
| 3 | **Veszélyes parancsok:** nincs kész, átvehető készlet. Sigma (Linux folyamatindítás) lehet a jelölt, ha a szabályok licence tiszta és a naplóészlelési forma illeszkedik egy futtatás előtti őrhöz | kutatás; addig a saját `DESTRUCTIVE` tábla marad |
| 4 | **Promptinjekció:** nincs elfogadott, karbantartott szabálykészlet (a vigil elavult, az llm-guard archivált). A garak próbái **tesztkorpuszként** használhatók a szűrőnk méréséhez | kutatás; a saját szűrő marad, a korlátait a `SYSTEM-OVERVIEW.md` rögzíti |

## 8. Amit nem tudunk, és amit nem állítunk

- A külső szabályok **minősége** nem bizonyított. A karbantartottság és az elterjedtség nem helyesség, a saját méréseink dönthetnek.
- A licenceket a GitHub mezője alapján néztem. Terjesztés előtt a licencfájlokat és a megőrzendő jogi közleményeket (NOTICE, szerzői jog) a repóban kell tartani; ezt a szelet 1 vállalja.
- A gitleaks-regexek JavaScripten való viselkedését az átalakító elkészültéig nem ismerjük.
- A tévedhetetlenséget semmilyen szabálykészlet nem adja: egy titokkereső is kihagy és tévedhet.

## 9. A fagyasztás kivétele

A `DIRECTION.md` 4. pontja az 1. fázis végéig befagyasztja az új radar-, eval- és védelmi szolgáltatásokat. Ez a terv a meglévő őr és kitakarás szabályforrását cseréli, új szolgáltatást nem vezet be, és a fejlesztő kifejezetten kérte. Kivételként a `DIRECTION.md` rögzíti. A kivétel határa: csak helyi, hálózat nélküli futásidejű kód, a hálózatot használó frissítő külön szkript és külön jóváhagyás.
