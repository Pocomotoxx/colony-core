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

## 7. Szeletek

| # | Szelet | Állapot |
|---|---|---|
| 1 | **Titokminták:** gitleaks v8.30.1 átvétele, betöltő, hash-ellenőrzés, átalakító, frissítő szkript, mérés, beillesztés | átvétel, átalakító, betöltő, kereső, mérés, a **jelzésként való bekötés** és a **frissítő szkript** kész; a blokkolás hátra van (a tervben rögzített feltétel után) |
| 2 | **Személyes adatok:** a presidio 2.2.366 mintáinak átvétele a kitakaráshoz (IP-cím, IBAN, bankkártya, MAC-cím; a magyar adószám, TAJ, bankszámla és az e-mail, telefon marad saját) | átvétel, Python-minta-kinyerő, átalakító, betöltő, ellenőrzők, mérés **kész**; a kitakarásba kötés hátra van (külön jóváhagyás) |
| 3 | **Veszélyes parancsok:** nincs kész, átvehető készlet. Sigma (Linux folyamatindítás) lehet a jelölt, ha a szabályok licence tiszta és a naplóészlelési forma illeszkedik egy futtatás előtti őrhöz | kutatás; addig a saját `DESTRUCTIVE` tábla marad |
| 4 | **Promptinjekció:** nincs elfogadott, karbantartott szabálykészlet (a vigil elavult, az llm-guard archivált). A garak próbái **tesztkorpuszként** használhatók a szűrőnk méréséhez | kutatás; a saját szűrő marad, a korlátait a `SYSTEM-OVERVIEW.md` rögzíti |

## 8. Amit nem tudunk, és amit nem állítunk

- A külső szabályok **minősége** nem bizonyított. A karbantartottság és az elterjedtség nem helyesség, a saját méréseink dönthetnek.
- A licenceket a GitHub mezője alapján néztem. Terjesztés előtt a licencfájlokat és a megőrzendő jogi közleményeket (NOTICE, szerzői jog) a repóban kell tartani; ezt a szelet 1 vállalja.
- A gitleaks-regexek JavaScripten való viselkedését az átalakító elkészültéig nem ismerjük.
- A tévedhetetlenséget semmilyen szabálykészlet nem adja: egy titokkereső is kihagy és tévedhet.

## 9. A fagyasztás kivétele

A `DIRECTION.md` 4. pontja az 1. fázis végéig befagyasztja az új radar-, eval- és védelmi szolgáltatásokat. Ez a terv a meglévő őr és kitakarás szabályforrását cseréli, új szolgáltatást nem vezet be, és a fejlesztő kifejezetten kérte. Kivételként a `DIRECTION.md` rögzíti. A kivétel határa: csak helyi, hálózat nélküli futásidejű kód, a hálózatot használó frissítő külön szkript és külön jóváhagyás.
