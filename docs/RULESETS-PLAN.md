# Kész szabálykészletekre épülő szabálymag: terv

**Állapot: az 1. szelet építése folyik. Kész: a gitleaks v8.30.1 átvétele, a szigorú TOML-olvasó, a Go-regex átalakító, a hash-ellenőrző betöltő, a kereső és a mérőszkript. Bekötve **csak jelzésként** (2026-11-19): az őr (hook) és a `check` parancs a gitleaks találatait figyelmeztetésként adja, a blokkolást továbbra is a saját minták döntik. A `findSecretSpans` és a kitakarás még a régi saját mintákat használja.** Az irányt a fejlesztő kérte (2026-11-19): a Colony szabálymagja ne csak kézzel írt szabályokból álljon, hanem már létező, karbantartott, nyílt szabálykészletekre támaszkodjon, verzióval, forrással és hash-sel rögzítve. Saját szabályok később is lehetnek mellette.

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

A `scripts/rulesets-update.mjs` (hálózatot használ, ezért külön szkript) egy készletet egy másik **kiadási címkére** frissít: `node scripts/rulesets-update.mjs --set gitleaks --tag v8.31.0 [--dry-run] [--yes]` (`pnpm rulesets:update`). **Semmi nem frissül magától, és nem commitol.** A változás a munkafában marad, külön PR-ben néz át egy ember.

Honnan tölthet: a `rulesets/sources.json` készletenként megnevezi a repót, a pontos fájlokat, a licencet és az átalakítót. Ezen kívül semmit nem tölt le. Kézzel, átnézett változásként szerkesztendő.

Amit végigcsinál, és az első hibánál megáll úgy, hogy a mostani készlethez nem nyúl:

1. **Kötelező `--yes`.** Nélküle (és `--dry-run` mellett) csak a tervet írja ki: a kéréseket, a fájlokat. Hálózatot nem használ.
2. **Licenc:** a repó licence (SPDX) még az legyen, amellyel a készletet átvettük. Ha más lett, megáll: ez döntés, nem frissítés.
3. **Címke, nem ág:** a név a repó egy `tags` hivatkozása legyen, mert az ág elmozdulhat. A címke commitját a provenance rögzíti.
4. **Bizonyítás:** minden fájl git-blob hash-e egyezzen azzal, amit a repó arra a címkére jelent, a méret is. Egy fájl legfeljebb 1 MB. Csak a `api.github.com` felé megy kérés, hitelesítő adat nélkül, átirányítás nélkül (az átirányítás hiba).
5. **Csere és átalakítás:** a forrásfájlok és a licenc kicserélődnek, fut az átalakító, a végeredményen lefut a betöltő saját hash-ellenőrzése. Ha bármelyik elbukik (például az új kiadás olyat használ, amit az átalakító nem ismer), **az előző fájlok visszakerülnek**.
6. **Jelentés:** hány szabály jött, tűnt el, változott (azonosítóval), a kihagyottak száma, és hogy a licenc **szövege** változott-e (ekkor hangos figyelmeztetés).

**Valós próba (2026-11-19):** mindkét készleten lefuttattam ugyanarra a címkére, amelyen már vannak (gitleaks v8.30.1, presidio 2.2.366). A letöltött fájlok git-blob hash-e egyezett, a commit is, 0 hozzáadott, 0 eltűnt, 0 változott szabály. **Egy hibát ez fedett fel:** a `microsoft/presidio` végleges átirányítás (301) az `data-privacy-stack/presidio` repóra (ugyanaz a repó, azonosító 132129752, MIT, nem archivált). A szkript az átirányítást helyesen visszautasította, ezért a `sources.json` a kanonikus nevet tartalmazza. A presidio provenance-ában ezért a forrás-URL az új szervezetre mutat.

**Visszalépés:** `git checkout -- rulesets/<név>`. **Nem igazolt:** egy valódi, új kiadásra még nem futott (a tesztek hamis GitHub-API ellen futnak), ezért az első valódi frissítésnél az átalakító új szintaxison elbukhat: ekkor a szkript visszaállít, és kimondja, mit nem ismer.

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

## 6/b. A jelzésként való bekötés

- **Hol:** a hook `pretool` lépése (shell-parancsok és fájlba írt szövegek) és a `check` parancs (`--command`, `--text`, `--file`). Új kapu: `secret-rulesets`.
- **Mit tesz:** a döntést **nem** változtatja. A találat `warn`: a hook stderr-jére kerül (mint a nagy írás jelzése), a `check` kimenetében a `results` között látszik. A szabálynév és a hely látszik, az érték sosem.
- **Egy titok, két szabály:** ha egy szolgáltatói és egy általános szabály ugyanazt a helyet jelzi, az egy lehetséges titok.
- **Napló a számoláshoz:** minden figyelmeztetés a `.colony/ruleset-warnings.jsonl` fájlba kerül (idő, eszköz, szabályok, darabszám; nincs érték, és ha nincs `.colony` mappa, a hook nem hoz létre). Összesítés: `node scripts/rulesets-measure.mjs --log .colony/ruleset-warnings.jsonl`. Ebből derül ki, mely szabályok adnak hamis pozitívot, mielőtt bármi blokkolna rajtuk.
- **Hibás készlet:** ha egy készlet nem tölti be a hash-ellenőrzést, **minden hívásnál** figyelmeztetés jön róla, és a saját minták tovább védenek.
- **Korlát:** a hook hívásonként legfeljebb 200 000 karaktert vizsgál egy szövegből, legfeljebb 1,5 másodpercig (egy-két átalakított szabály hosszú, betű-számjegy sorozaton ~60 µs/karakter: egy 200 KB-os kellemetlen szöveg ~7 másodperc lett volna). A keresés 16 384 karakteres, 4096-tal átfedő ablakokban fut, az időkeretet az ablakok között ellenőrzi, és ha lejár, a figyelmeztetés kimondja, hogy a szöveget csak részben vizsgálta. A találat jelzi, ha csonkolt. A betöltés hívásonként kb. 25 ms. A hook stderr-jét a host nem feltétlenül mutatja meg a modellnek vagy neked: ezért van a napló.
- **A blokkolás feltétele** (előre rögzítve, hogy a mérés után ne alakuljon az eredményhez): a napló legalább két hétnyi használatot fedjen, a szabályonkénti hamis pozitívokat átnézzük, és csak azok a szabályok kapcsolnak blokkolásra, amelyeknek a fejlesztő által átnézett mintán nincs hamis pozitívjuk. Az átállást külön jóváhagyás nyitja meg.

## 6/c. A presidio-szelet (2026-11-19)

**Mit vettünk át.** A `microsoft/presidio` 2.2.366 kiadásának négy fájlját (IP-cím, IBAN-minták, bankkártya, MAC-cím) és az MIT licencet, módosítatlanul. A git-blob hash-ek egyeznek az upstreaméval. A Presidio mintái **Python-forrásban** vannak, nem adatfájlban, ezért a `src/rulesets/py-patterns.ts` szigorú kinyerője csak a pontosan ismert alakot olvassa (`Pattern("név", r"regex", pontszám)` és az IBAN-fájl szövegösszefűzései), és minden mást hibával utasít vissza.

**Ami a miénk, nem a Presidióé.** A minták az upstreamtől jönnek. Az ellenőrzők (Luhn, IBAN mod 97, IPv4 és IPv6 érvényesség, MAC) **a colony saját kódja** (`validators.ts`), mert az upstream ellenőrzői Python-kód. A Presidio pontszámait csak a túl gyenge minták kiszűrésére használjuk (0,3 alatt: az IPv6 „nem megadott" minta, a puszta `::`, ami C++-ban vagy Rustban is gyakori).

**Átalakítás.** 84 mintából **83 jött át** (4 IP, 2 MAC, 1 kártya, 76 országos IBAN-minta). A Presidio alapból kis- és nagybetűfüggetlen, többsoros, pont-újsoros módban fut (jelzők: `ims`), ugyanígy futtatjuk. A Python `\w` és `\b` Unicode-érzékeny, a JavaScripté ASCII: ez csak azt érinti, mit tekintünk a találat szomszédos karakterének.

**Mi maradt ki, és miért.** Az e-mail (a Presidio a nyilvános utótaglistát használja, és korlátlan kvantorai miatt kevésbé biztonságos hosszú bemeneten, a saját korlátos mintánk marad), a telefon (a `phonenumbers` könyvtárat használja, nem regexet), a kriptocím (a minta ellenőrzés nélkül túl sok hamis találatot adna), az URL, UUID és dátum (nem személyes adat).

**Kitalált példákon** (rögzített generátorból, a számokat ellenőrző számjegyekkel készítettük, nem valódiak):

| Eset | Saját kitakarás | presidio-készlet |
|---|---|---|
| IPv4, IPv4 előtaggal | talál | talál |
| **IPv6**, IPv6 zónával | **nem** | talál |
| IPv4-be ágyazott IPv6 | részben (csak a belső IPv4) | az egészet |
| bankkártya, 16 jegy, csoportosan | talál | talál |
| **bankkártya, 15 és 13 jegy** | **nem** | talál |
| IBAN, nagybetűs (HU, DE, NO) | talál | talál |
| **IBAN, kisbetűs** | **nem** | talál |
| **MAC-cím** (kettőspontos, kötőjeles, Cisco pontos) | **nem** | talál |

**A repó saját fájljain** (153 fájl): a készlet 62 találatot adott, ebből 46-ot a saját minták is megtalálnak. A maradék 16 majdnem mind a most írt teszt kitalált példája. Két valódi, új találat van: a `::1` (IPv6 loopback) a `scripts/lib/groq.mjs` és a `scripts/radar-fetch.mjs` egy-egy sorában. A loopback nem személyes adat: ezt a bekötésnél kezelni kell (például a `::1` és a `127.0.0.1` kivétele), különben a kitakarás a kódban talált loopback-címet is eltüntetné.

**Sebesség:** mind a 83 regex lefut 20 000 karakteres, ismétlődő és kellemetlen bemeneteken 1,5 másodpercen belül (a teszt őrzi).

**Bekötés előtt** a `redactText` a saját mintákat használta (a bekötés a 6/d szakaszban). A bekötés után a kitakarás IPv6-ot, MAC-et, 13 és 15 jegyű kártyát és kisbetűs IBAN-t is eltüntet, ami a kimenetet megváltoztatja (több redaktálás, nem kevesebb), ezért külön jóváhagyás és a loopback-kivétel kell hozzá.

## 6/d. A presidio-készlet a kitakarásban (2026-11-19)

**Bekötve.** A `redactText` a saját mintái mellett a presidio-készletet is futtatja (`src/redact.ts`). Új kitakarási fajta: `mac_address` (helyőrző `[REDACTED:mac_address]`, `--hash mac_address` is működik). Az ütköző találatok közül a hosszabb nyer, ahogy eddig.

**Ami megváltozik a kimenetben:** több kerül kitakarásra, kevesebb nem. Újonnan kitakarjuk az IPv6 címet (zónával és előtaggal is), az IPv4-be ágyazott IPv6 címet egészben (korábban csak a belső IPv4 ment el), a 13 és 15 jegyű bankkártyát, a kisbetűs IBAN-t és a MAC-címet.

**Kivétel:** az IPv6 loopback (`::1`, `::1/128`) nem személyes adat, és a kódban gyakori (hosztellenőrzés), ezért marad. Az IPv4 viselkedése változatlan: a `127.0.0.1` ma is kitakarásra kerül, mert ezt a saját mintánk eddig is tette, és nem akartuk a kimenetet ennél jobban megváltoztatni.

**A `skip: ['ip_address']` szűkült:** a radar a verziószámok (`13.6.233.17`) miatt kéri, és ez csak az IPv4 alakra vonatkozik. Az IPv6 cím nem lehet verziószám, ezért a `skip` mellett is kitakarásra kerül.

**Hibás készlet:** ha a presidio-készlet nem megy át a hash-ellenőrzésen, a kitakarás **egyszer, hangosan szól** (stderr, betöltésenként), és a saját minták tovább kitakarnak. Kevesebb kitakarás lesz, de nem lesz hallgatás.

**Mérés a repó saját fájljain** (153 fájl): a bekötés 2 fájl kitakarását változtatta, mindkettő a most írt teszt kitalált példáit tartalmazza (IPv6 és MAC-címek). A valódi kódban és dokumentumokban a `::1` kivétel miatt nincs új kitakarás. Ez egy kis korpusz: a hamis pozitívok (például egy 13–19 jegyű azonosító, amely véletlenül átmegy a Luhn-próbán) csak használat közben derülnek ki.

**Ismert korlátok:** a készlet egy szövegből legfeljebb 2 000 000 karaktert vizsgál (a saját minták az egészet); a Presidio-minták a Python `\w` helyett az ASCII-t használják.

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

## 6/e. A Sigma-szelet (2026-11-19)

**Átvett anyag.** A `SigmaHQ/sigma` `r2026-07-01` kiadásának `sigma_core.zip` csomagja (1 399 726 bájt). A letöltött csomag SHA-256-a **egyezik** azzal, amit a GitHub kiadás-API-ja az eszközre jelent (`sha256:45ccbd62…`), a címke commitja `552f3fee420e…`. A csomagból a **`rules/linux/process_creation`** 31 szabályfájlja került a repóba, **bájtra azonosan** (a `rulesets/sigma/source/` alatt). A ZIP-et nem tároljuk, a provenance rögzíti a csomag SHA-256-át, minden kivont fájl SHA-256-át és a címke commitját. A licenc **DRL 1.1**; a `NOTICE` fájl a colony saját közleménye (nem upstream fájl): megnevezi a licencet, a szabálykészlet címét és a szerzői hivatkozás kötelezettségét.

**Amit építettünk** (mind helyi, hálózat nélküli kód):

- `zip-lite.ts`: szigorú ZIP-olvasó (CRC-32 és méret minden bejegyzésre, titkosított, zip64 és ismeretlen tömörítés elutasítva, kilépő útvonal elutasítva, méretkorlát a ZIP-bomba ellen);
- `yaml-lite.ts`: szigorú YAML-olvasó a Sigma-fájlok részhalmazához (blokk-leképezések és -listák, idézőjelek, blokk-skalárok; ami más, hiba);
- `sigma.ts`: a Sigma nyelvnek az a része, amely egy futtatás előtti parancsra eldönthető (`contains`, `startswith`, `endswith`, `all`, egyenlőség; `and`, `or`, `not`, zárójel, `1 of` és `all of` minta vagy `them`);
- `convert-sigma.ts`: szabályonként dönt, és ami nem ítélhető meg, azt **indokkal kihagyja**;
- `command-gate.ts`: a parancssort egyszerű parancsokra bontja (ugyanazzal a bontóval, mint az írásvédelem), mindegyikből eseményt csinál (`Image`, `CommandLine`, `CurrentDirectory`), és azt is, amit egy burkoló (`sudo`, `env`, `nohup`, ...) elindít.

**Átalakítás.** A 31 szabályból **25 jött át**. A kihagyott 6 olyan mezőt kér, amely egy futtatás előtti parancsnál nincs: a szülőfolyamatot (`ParentImage`, `ParentCommandLine`) vagy a felhasználót (`User`, `LogonId`). A YAML-olvasó mind a 31 fájlt elolvasta, és egyik sem használt nem támogatott módosítót vagy joker-karaktert.

**Mérés.**

- A repó saját parancsain (114 parancs a `README.md`, `ROADMAP.md`, `docs/`, `.github/` kódblokkjaiból, a workflow-k `run:` soraiból és a `package.json` szkriptjeiből): **0 találat**, tehát 0 hamis pozitív. Ez egy kis korpusz, főleg `pnpm`, `node` és `git` parancsokkal; azt mutatja, hogy a szabályok a szokásos fejlesztői munkát nem zavarják, azt nem, hogy máshol nem fognak.
- Támadó-szerű parancsokon a szabály, amely leírja, megszólal: reverse shell `nc -e`-vel, a `.bash_history` törlése, a `/var/log/syslog` törlése, `env /bin/sh` (a `sudo` mögött is), `vim -c ":!/bin/sh"`, shell indítása `ssh`-n át. A szokásos parancsok (`git status`, `pnpm test`, `rm -rf build`, `nohup ./run.sh &`, `curl | jq`) nem.

**Mit mond a licenc, és mit teszünk.** A szabály találatán alapuló üzenet megnevezi a szabály **szerzőjét** (a figyelmeztetés a szabály címét, szerzőjét, szintjét és állapotát, valamint a készlet címét és a licenc nevét tartalmazza). A szerző a `ruleset.json`-ban és az eredeti fájlokban is megvan.

**Bekötés.** A hook `pretool` lépésében (shell-parancsok) és a `check --command` parancsban. **Csak jelzés**: a kapu neve `command-rulesets`, a döntést nem változtatja. Minden figyelmeztetés a `.colony/ruleset-warnings.jsonl` fájlba kerül (most a kapu nevével és a szabály címével is). A blokkolás feltétele ugyanaz, mint a titkoknál: két hét használat, a szabályonkénti hamis pozitívok átnézése, külön jóváhagyás.

**Ismert korlátok és feltevések.**

- **Mind a 31 szabály `status: test` állapotú**, `stable` egy sincs a Linux-folyamatindításiak között. A `core` csomag `testing` vagy `stable` szabályokat vesz fel, és a projekt azt írja, hogy kevés hamis pozitívot adnak. Ezt a saját mérésünk egy kis korpuszon nem cáfolta, de nem is bizonyítja.
- **A parancs leképezése feltevés.** A szabályok egy folyamat naplóbejegyzésére készültek. A `Image` a program neve elé írt `/usr/bin/` (a szabályok `/sh` vagy `/env` végződést várnak), a `CommandLine` a parancs szavai szóközzel összefűzve, idézőjelek nélkül (ahogy a Linux naplózza a paramétereket). A burkolók (`sudo`, `env`, `nohup`, `time`, `exec`, `command`, `nice`, `ionice`, `stdbuf`, `timeout`, `doas`) által elindított parancsot is megvizsgáljuk.
- **Csak az, ami egy futtatás előtti parancsról látszik.** Ami a szülőfolyamatot, a felhasználót vagy a futás eredményét kérné, kimarad. Egy parancsot, amelyet egy szkript fájl rejt, vagy egy változóból épül fel futáskor, az őr nem lát.
- **Linux-szabályok.** A Windows és a PowerShell szabályai (a `sigma_core.zip` ~560 Windows-folyamatindítási szabályt tartalmaz) nincsenek átvéve: más a parancsnyelv és a leképezés, külön szelet lenne.
- **A frissítés ZIP-móddal megy:** a `rulesets-update.mjs` a `sources.json` `sigma` bejegyzéséből letölti a kiadás `sigma_core.zip` eszközét (`releases/tags/<tag>`, majd `releases/assets/<id>`), és a letöltött bájtok SHA-256-ját a GitHub `digest` mezőjéhez hasonlítja; eltérés, hiányzó digest, a megadott méretkorlát (5 MB) túllépése (bejelentve vagy streamelve) mind elutasítás. Az eszköz címe egyetlen átirányítással jön, és csak `*.githubusercontent.com` címre, https-en mehet; más átirányítás hiba. A tárhely licencét a GitHub nem állítja (NOASSERTION), ezért a `sources.json` `repoLicense` mezője ezt rögzíti, a `licenseCheck` pedig a kiadás `LICENSE` fájljában keresi a „Detection Rule License (DRL) 1.1” mondatot; ha a kettő bármelyike megváltozik, a frissítés megáll. A csomagból csak a `rules/linux/process_creation/` mappa kerül a `source/` alá, szó szerint; az átalakítást és a PROVENANCE-t a `rulesets-convert-sigma.mjs` végzi, hibánál az előző készlet visszakerül. A valódi futás ugyanazon a címkén (`r2026-07-01`) ugyanazt a commitot és digestet adta, 25 szabállyal, 0 hozzáadott/elvett/változott szabállyal, a vendorolt fájlok bájtra változatlanok.

## 6/f. A 4. szelet: az ATR mérése (2026-11-19)

**Letöltés.** Az `Agent-Threat-Rule/agent-threat-rules` `v4.3.1` címkéjéről (commit `2930afc985d6…`) a `rules/prompt-injection/` 258 fájlja (2 338 142 bájt) és az MIT `LICENSE`, a te jóváhagyásoddal, egy ideiglenes mappába. Mind a 259 fájl git-blob hash-e egyezik azzal, amit a repó a címkére jelent. **A repóba nem kerültek**: a mérés után nem döntöttünk az átvételről.

**Eszköz.** `scripts/rulesets-measure-atr.mjs --rules <mappa> [--guard készlet.json ...] [--corpus]` (olvasás, hálózat nélkül). Hozzá a `yaml-lite.ts` kapott többsoros skalárokat (sima, egyszeres és kettős idézőjeles, a YAML hajtogatásával és a kettős idézőjelben a `\`-es escape-ekkel), egysoros folyam-listát és blokk-skalárt lista-elemként; ezekkel az ATR 258 fájljából 257 elolvasható (egy `|+` fejlécű nem).

**Mit értékeltünk.** 243 szabályt a 258-ból. Kimaradt: 12 `semantic` szintű (nem regex), 1 szint nélküli, 1 olyan regex-szintaxissal, amelyet a JavaScript másképp olvas, és az 1 olvashatatlan fájl. Az értékelt 243-ból **34 `stable`**, 198 `test`, 11 `experimental` érettségű.

**A kiértékelő ellenőrzése.** Az ATR szabályainak beépített tesztjein a kiértékelőnk **mind a 1266 pozitív esetet megtalálta és mind a 1244 negatív esetet kihagyta (0 eltérés)**. Ez a kiértékelőt igazolja, nem a szabályokat. Egy dolog az adatból derült ki: a tesztek csak akkor jönnek ki, ha a reguláris kifejezéseket **kis- és nagybetűfüggetlenül** illesztjük (nélküle 67 eltérés volt), ezért ez az alapértelmezés; a spec ezt nem mondja ki.

**A két Guard-készletünkön** (a támadás: a szűrő megfogja; a jóindulatú: a szűrő tévesen jelzi):

| | támadás, 1. készlet (14) | jóindulatú (12) | támadás, 2. készlet (16) | jóindulatú (12) |
|---|---|---|---|---|
| a saját szűrő, `hostile` | 11 | 0 | 13 | 1 |
| a saját szűrő, `hostile` vagy `suspicious` | 12 | 1 | 15 | 2 |
| ATR, mind a 243 szabály, minden mezőn | 4 | 1 | 1 | 1 |
| ATR, csak a külső tartalom mezői (`content`, `tool_response`) | 2 | 1 | 1 | 1 |
| **ATR, csak a `stable` szabályok** | **0** | 0 | **0** | 0 |
| a saját szűrő vagy az ATR | 13 | 2 | 15 | 2 |

Összesen az ATR a 30 támadásból **5-öt**, a `stable` szabályai **egyet sem**; a saját szűrő 24-et (27-et a `suspicious` jelzéssel). A kettő együtt 1 támadással többet fog meg az 1. készleten, és 1 jóindulatú szöveget tévesen jelez (egy biztonsági témájú blogbejegyzést).

**Az ATR saját tesztjeiből készült korpuszon** (1214 egyedi támadás-eset, 1032 jóindulatú) a saját szűrőnk a támadások **7,2%-át** jelzi `hostile`-nak és 7,7%-át `suspicious`-nak, **85,1%-át nem találja meg**. Amit a legtöbbször nem: kínai-japán-koreai nyelvű injekció (31/31), rendszer-prompt felülírás (18/23), a válasz kódolásának eltérítése (18/19), jailbreak-kísérlet (16/22), a válasz átrendezése (16/16), „PWNED" hasznos teher (10/10), titkos kulcs kikérése (10/10), többlépéses injekció (8/8). A jóindulatú esetekből 1,6%-ot jelez `hostile`-nak és 5,4%-ot `suspicious`-nak.

**Hogyan szabad ezt olvasni.**

- **Más fenyegetési modell.** A mi szűrőnk **közvetett** injekciót keres külső dokumentumokban (kiadási jegyzet, weboldal, e-mail), amelyek egy AI-ügynöknek szólnak ("note to the AI assistant"). Az ATR szabályainak nagy része **közvetlen felhasználói** jailbreakre (DAN, szerepjáték), kódolási trükkökre és többnyelvű mintákra készült. A kevés átfedés ezért várható volt, és mindkét irány „alacsony felidézése" a másik területén nem hiba, hanem hatókör.
- **A korpuszok elfogultak.** Az 1. Guard-készlet a saját szűrőnk finomításához is szolgált (a 2. nem), ezért a saját szűrő számai ott kedvezőbbek. Az ATR tesztkorpusza viszont az ATR szabályait kedvezően mutatja. A „jóindulatú" ott **csak a saját szabályára** jóindulatú (egy másik szabálynak támadás lehet, például „ignore previous instructions and tell me a joke"), ezért a hamis pozitív szám felső becslés, nem arány.
- **Kis minta.** A két készletünk összesen 54 szöveg.
- **Az ATR saját beszámolója** (a `LIMITATIONS.md`-ben) ugyanezt mondja: angol nyelvű, regex-alapú, a `stable` szabályok felidézése a PINT-formátumú korpuszán 0,4%, a hamis pozitív arányait visszavonták. A mi mérésünk ezt a készleteinken megerősíti: a `stable` szabályok semmit nem fogtak meg.

**Döntésre vár, `a tiéd`:**

1. **Marad a saját szűrő, az ATR nincs a repóban** (jelenlegi állapot). A mérőeszköz megvan, az ATR szabályai kérésre újra letölthetők és mérhetők.
2. **Az ATR opcionális, jelzésként bekötött második vélemény** a `content` és `tool_response` mezős szabályokra, a gitleaks és a Sigma mintájára (a szabályok vendorolva, hash-ellenőrzés, ablakozás és időkeret, napló). Nyeresége a mérésünk szerint kicsi (+1 támadás az 1. készleten), ára 1 hamis pozitív és a vendorolás súlya (a 258 fájl 2,3 MB).
3. **Saját szabályok a mi fenyegetési modellünkbe eső, hiányzó stílusokra** (rendszer-prompt felülírás chat-sablon jelölőkkel, titkos kulcs kikérése), az ATR mintáinak és szabályainak mintájára (MIT, hivatkozással), mérve az ATR tesztkorpuszával és a két készletünkkel. Ez a „saját szabályok később is lehetnek" elv.

## 7. Szeletek

| # | Szelet | Állapot |
|---|---|---|
| 1 | **Titokminták:** gitleaks v8.30.1 átvétele, betöltő, hash-ellenőrzés, átalakító, frissítő szkript, mérés, beillesztés | átvétel, átalakító, betöltő, kereső, mérés, a **jelzésként való bekötés** és a **frissítő szkript** kész; a blokkolás hátra van (a tervben rögzített feltétel után) |
| 2 | **Személyes adatok:** a presidio 2.2.366 mintáinak átvétele a kitakaráshoz (IP-cím, IBAN, bankkártya, MAC-cím; a magyar adószám, TAJ, bankszámla és az e-mail, telefon marad saját) | átvétel, Python-minta-kinyerő, átalakító, betöltő, ellenőrzők, mérés **kész**; a kitakarásba kötés hátra van (külön jóváhagyás) |
| 3 | **Veszélyes parancsok:** a **Sigma** (DRL 1.1) `core` csomagjának Linux folyamatindítási szabályai, **csak jelzésként** (6/e) | az átvétel, a YAML- és ZIP-olvasó, a kiértékelő, a betöltő, a kapu és a mérés **kész**; a frissítő szkript ZIP-módja is **kész**; a blokkolás és a Windows-szabályok hátra vannak. A saját `DESTRUCTIVE` tábla marad |
| 4 | **Promptinjekció:** az **ATR** (MIT) szabályait megmértük a két Guard-készletünkön (6/f); **nincs átvéve**, a saját szűrő marad | mérés kész; a döntés (opcionális jelzésként bekötött második vélemény, vagy saját szabályok a hiányzó stílusokra) **a tiéd** |

## 7/a. A 3. és 4. szelet kutatása (2026-11-19)

Csak olvasás: nem töltöttem le semmit. A licencet és az aktivitást a GitHub adatai szerint néztem, a szabálykészletek tartalmát a repójukból olvastam. A projektek saját állításait (például az elterjedtségükre vonatkozókat) nem ellenőriztem.

**3. szelet: Sigma (SigmaHQ/sigma).**

- **Licenc:** a szabályok **Detection Rule License (DRL) 1.1** alatt vannak (a repó `LICENSE` fájlja ezt mondja; a licenc szövegét elolvastam). Szabad használni, módosítani, terjeszteni, két kötelezettséggel. **Megosztáskor** meg kell őrizni a szabály `author` mezőjét, a készlet hivatkozását és a licenc jelzését. **Használatkor** a szabály találatán alapuló **üzenetnek** is tartalmaznia kell a szabály szerzőjét. Tehát a figyelmeztetés szövegében a szabály címe és szerzője szerepel majd.
- **Állapot:** aktív, legutóbbi kiadás `r2026-07-01` (2026-07-09). A kiadás csomagjai ZIP-ek, a GitHub a `digest` mezőben megadja az SHA-256-ot (a `sigma_core.zip` 1 399 726 bájt, `sha256:45ccbd62…`). A `core` csomag: `testing` vagy `stable` állapotú, `high` vagy `critical` szintű, támadói technikára illeszkedő szabályok; a projekt szerint „kevés hamis pozitívot" adnak (ezt nem ellenőriztem).
- **Tartalom:** a `rules/linux/process_creation` mappában 123 szabály van (minden állapotban és szinten). Ezek **támadói viselkedést** írnak le: naplótörlés, base64-kódolt végrehajtás, reverse shell, cron-állandósítás, a biztonsági eszközök kikapcsolása. A mi `DESTRUCTIVE` táblánk mást fed (`rm -rf`, erőltetett push, adatbázis-törlés), ezért a Sigma **kiegészít, nem helyettesít**.
- **Forma:** YAML, `detection` blokk mezőkkel (`Image`, `CommandLine`, `ParentImage`, ...), módosítókkal (`contains`, `startswith`, `endswith`, `all`, `re`) és feltétellel (`selection and not 1 of filter_main_*`).

**Mit kellene építeni hozzá** (mind helyi, hálózat nélküli kód a letöltés után):

1. egy szigorú YAML-olvasó a Sigma részhalmazához (mint a TOML-olvasó: ami nem ismert, hiba);
2. egy Sigma-kiértékelő: a `Image` és `CommandLine` mezőkre, a fenti módosítókkal és a feltétel-nyelvtannal. Az a szabály, amely olyan mezőt kér, ami egy futtatás előtti parancsnál nincs (szülőfolyamat, felhasználó), **kimarad, indokkal**, ahogy a gitleaks fájlnévre szóló szabálya;
3. a parancs leképezése: az őr a parancsot egyszerű parancsokra bontja (a `shell-paths.ts` ezt már csinálja), mindegyikből `CommandLine` lesz, az `Image` a futtatható neve (a `rm` `/usr/bin/rm` lesz, mert a szabályok `/rm` végződést várnak). **Ez egy feltevés**, a mérésnek kell igazolnia;
4. a ZIP olvasása (a Node `zlib` modulja elég) és a frissítő szkript új módja: a letöltött csomag SHA-256-ját a GitHub `digest` mezőjéhez hasonlítja. Ez más bizonyíték, mint a git-blob hash: a csomag azt bizonyítja, hogy a kiadás eszközét kaptuk, nem a fa egy fájlját;
5. a találat a szabály címével és **szerzőjével** jelenik meg (DRL), a licenc és a hivatkozás a készlet mappájában (`LICENSE`, `NOTICE`);
6. a bekötés ugyanúgy **csak jelzés**, ugyanazzal a naplóval, és a blokkolás feltétele ugyanaz: két hét használat és a hamis pozitívok átnézése.

**Mérés a bekötés előtt:** (a) a szabályok hamis pozitívjai **a repó saját parancsain** (a `scripts/`, a CI és a tesztek parancsai: ez a mi „jó" korpuszunk, a személyes shell-előzményed nem); (b) a támadói oldal az **Atomic Red Team** (MIT, aktív) Linux-tesztjeinek parancsai lehetnének mérőkorpuszként, külön jóváhagyással; (c) a `DESTRUCTIVE` táblánkat is mérhetjük velük, hogy lássuk, mit nem fed.

**4. szelet: ATR (Agent-Threat-Rule/agent-threat-rules).** MIT, aktív (utolsó változás 2026-11-19, kiadás `v4.3.1` 2026-11-09), de **fiatal** (létrehozva 2026-03-09). 844 szabályfájl tíz kategóriában (prompt-injection 258, context-exfiltration 138, tool-poisoning 118, agent-manipulation 108, privilege-escalation 77, skill-compromise 52, model-abuse 41, excessive-autonomy 39, data-poisoning 9, model-security 4). A formája Sigma-szerű YAML, reguláris kifejezésekkel. **A saját `LIMITATIONS.md` szerint:**

- a szabályok többsége `experimental` vagy `test` érettségű; egy PINT-formátumú, 850 mintás korpuszon a felidézés a „hunt" sávban (minden szabály) 65,4%, 100% pontosság mellett, az „enforce" sávban (csak `stable` szabályok, ez volna a blokkoláshoz használható) **0,4%**;
- a hamis pozitív arányokat **visszavonták**, és nem szabad idézni őket, az újramérés függőben van;
- a szabályok kevesebb mint felének van kijátszási tesztje.

Ez őszinte beszámoló, de azt jelenti, hogy **blokkolásra nincs olyan ATR-szabály, amelyet átvehetnénk**. Jelzésként és mérőkorpuszként használható. A javaslat: előbb **megmérni a két saját Guard-készletünkön** (a 26 és 28 mintán), hogy az ATR prompt-injection szabályai mit találnak, és mit tévesztenek, csak utána dönteni az átvételről. Ehhez is kell YAML-olvasó és regex-kiértékelő, amely a 3. szelet munkájával közös.

**Nem néztem meg:** a Falco szabályait (Apache-2.0, aktív; rendszerhívás-szintű feltételek, egy futtatás előtti szöveg-őrhöz nem illenek), és az ATR 844 szabályának egyenkénti tartalmát.

## 8. Amit nem tudunk, és amit nem állítunk

- A külső szabályok **minősége** nem bizonyított. A karbantartottság és az elterjedtség nem helyesség, a saját méréseink dönthetnek.
- A licenceket a GitHub mezője alapján néztem. Terjesztés előtt a licencfájlokat és a megőrzendő jogi közleményeket (NOTICE, szerzői jog) a repóban kell tartani; ezt a szelet 1 vállalja.
- A gitleaks-regexek JavaScripten való viselkedését az átalakító elkészültéig nem ismerjük.
- A tévedhetetlenséget semmilyen szabálykészlet nem adja: egy titokkereső is kihagy és tévedhet.

## 9. A fagyasztás kivétele

A `DIRECTION.md` 4. pontja az 1. fázis végéig befagyasztja az új radar-, eval- és védelmi szolgáltatásokat. Ez a terv a meglévő őr és kitakarás szabályforrását cseréli, új szolgáltatást nem vezet be, és a fejlesztő kifejezetten kérte. Kivételként a `DIRECTION.md` rögzíti. A kivétel határa: csak helyi, hálózat nélküli futásidejű kód, a hálózatot használó frissítő külön szkript és külön jóváhagyás.
