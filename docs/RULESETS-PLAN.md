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

**Visszalépés:** `git checkout -- rulesets/<név>`. **Nem igazolt:** egy valódi, új kiadásra még nem futott (a tesztek hamis GitHub-API ellen futnak), ezért az első valódi frissítésnél az átalakító új szintaxison elbukhat: ekkor a szkript nem érinti a meglévő készletet, és kimondja, mit nem ismer.

**Frissítés a külső audit után (B02, B03).** A fájlokat a szkript a címke helyett arra a commitra kéri, amelyre a címkét feloldotta, és a letöltés végén újra megkérdezi a címke commitját: ha elmozdult, elutasítja. Az új készletet egy előkészítő mappában (`rulesets/.stage-*`) építi fel: a meglévő készlet másolatán fut az átalakító és a betöltő ellenőrzése, és csak ezután cseréli be két átnevezéssel (ha a második elbukik, az elsőt visszacsinálja). Egy zár (`rulesets/.update.lock`) két párhuzamos frissítést elválaszt; a szkript kilépéskor mindkettőt takarítja, de egy megölt folyamat után kézzel kell törölni a zárat (az üzenet ezt mondja). **Nem védett:** a két átnevezés közötti pillanatban kilőtt folyamat készlet nélkül hagy egy mappát; ezt a betöltő most hiányzó készletként jelzi (B01).

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
- **Korlát:** a hook hívásonként legfeljebb 200 000 karaktert vizsgál egy szövegből, legfeljebb 1,5 másodpercig (a teljes gitleaks-készlet egy 20 000 karakteres, betű-számjegy sorozaton ~1,5 másodperc, vagyis ~75 µs/karakter, egy 200 KB-os kellemetlen szöveg ablakolás és időkeret nélkül ~15 másodperc lenne; a korábban itt közölt „~60 µs/karakter, ~7 másodperc" számot a mai mérés nem ismételte meg, a mérés mintáját nem őriztük meg. Mérés: Windows 11, i7-8565U, Node 24.13.1, 2026-11-20, két futás; a legnagyobb egyetlen szabály 20 000 karakteren ~225 ms). A keresés 16 384 karakteres, 4096-tal átfedő ablakokban fut, az időkeretet az ablakok között ellenőrzi, és ha lejár, a figyelmeztetés kimondja, hogy a szöveget csak részben vizsgálta. A találat jelzi, ha csonkolt. A betöltés hívásonként kb. 25 ms. A hook stderr-jét a host nem feltétlenül mutatja meg a modellnek vagy neked: ezért van a napló.
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

**Sebesség.** A teszt egysége: **egy szabály egy bemeneten** (9 kellemetlen, 20 000 karakteres bemenet), küszöbe 1500 ms; ez egy katasztrofális visszalépést fog meg, a sebességet nem méri. Mért (Windows 11, i7-8565U, Node 24.13.1, 2026-11-20, két futás): egy szabály egy bemeneten legfeljebb 1 ms, a teljes 83 szabályos készlet egy bemeneten legfeljebb 6 ms, vagyis a tényleges érték a küszöb ezredrésze.

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

**Sebesség.** A teszt egysége: **egy szabály egy bemeneten** (8 kellemetlen, 20 000 karakteres bemenet), küszöbe **8000 ms**, szándékosan laza (egy terhelt gépen is át kell mennie): egy katasztrofális visszalépést fog meg, nem egy lassú szabályt; ez **nem** állítja, hogy a készlet 1,5 másodpercen belül fut. Az 1,5 másodperc a hook időkerete (`GUARD_BUDGET_MS`), amelyet az ablakok között ellenőriz. Mért (Windows 11, i7-8565U, Node 24.13.1, 2026-11-20, két futás): egy szabály egy bemeneten legfeljebb ~225 ms; a teljes 221 szabályos készlet egy 20 000 karakteres bemeneten a 8 kellemetlen szövegen 9 és 1540 ms között (a betű-számjegy sorozatokon ~1,5 s, a szóközön és az egyenlőségjeleken ~10 ms). Egy gyors próba, nem garancia.

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
- **Linux-szabályok.** Ez a készlet csak a Linux folyamatindításiakat tartalmazza; a Windows-szabályok külön készletben vannak (6/g).
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

## 6/g. A Windows-szelet (2026-11-19)

**Átvett anyag.** Ugyanaz a csomag, mint a Linux-készleté (`sigma_core.zip`, `r2026-07-01`, `sha256:45ccbd62…`, commit `552f3fee420e…`): a `rules/windows/process_creation` mappa **558** fájlja, bájtra azonosan a `rulesets/sigma-windows/source/` alatt (a mappa 3,4 MB), külön készletként (`sigma-windows`, saját `PROVENANCE.json` és `NOTICE`, DRL 1.1). A készletet a `rulesets-update.mjs` valódi futása is előállította (2026-11-19, a te jóváhagyásoddal letöltött `sigma_core.zip`, 1 399 726 bájt): a digest egyezett (`sha256:45ccbd62…`), a commit is, a vendorolt forrásfájlok nem változtak.

**Átalakítás.** 558 szabályból **350 jött át** (336 az első változatban, +10 a joker-karakterek, +4 a `base64offset` olvasása után), 208 kimaradt indokkal: 197 olyan mezőt kér, amely egy futtatás előtti parancsnál nincs (`ParentImage` 125, `Description`, `ParentCommandLine`, `Hashes`, `IntegrityLevel`, `Product`, `User`, ...), 11 üres vagy nem szöveges értéket. Új a nyelvben:

- `re`: a mintát a gitleaks-készletnél már használt RE2→JavaScript fordító olvassa; **kis- és nagybetű érzékeny**, `re|i`-vel nem; egy minta a mező első 8000 karakterén fut (hogy egy hosszú parancs ne lassítsa);
- `windash`: az argumentumot kezdő kötőjel (szóköz vagy az érték eleje után) `/` vagy hosszú gondolatjel (`–`, `—`, `―`) is lehet; a `windash|all` értékenként külön feltétel. Ez az én olvasatom a spec leírásáról, nem a hivatalos eszköz (pySigma) viselkedésének ellenőrzött másolata;
- `base64offset|contains`: az érték megkeresése base64 szövegben, bármelyik igazításban (három változat, a szomszéd bájtoktól függő karakterek levágva, a pySigma eljárása szerint, de a pySigma kimenetét nem vetettem össze az enyémmel). **Kis- és nagybetűre érzékeny**, mert a szabályok szerzői külön felsorolják a nagybetűs változatokat; a 4 karakternél rövidebb base64 változatot adó érték és a nem `contains` operátor elutasítva;
- **joker-karakterek** (`*` bármennyi karakter, `?` pontosan egy), a Sigma-specifikáció szerinti escape-eléssel (a specifikációt elolvastam): `\*` és `\?` sima karakter, `\\*` egy visszaper és egy joker, `\\\*` egy visszaper és egy sima csillag; a joker nélküli visszaper-sorozat felét számítja felfelé kerekítve (1-2 db egy, 3-4 db kettő). A minta nem reguláris kifejezés: szegmensenként, sorrendben keresi a szöveget (visszalépés nélkül), és a mező-módosító rögzíti (`startswith` az elejére, `endswith` a végére, `contains` sehova). **Ez a szabály a joker nélküli értékekre is vonatkozik**, és a Windows-készlet 11 szabályánál megváltoztatta az olvasatot: az UNC-útvonalat kereső szabályok (`\\\\` az értékben) az első változatban négy visszapert kerestek, ami egy valódi `\\szerver` útvonalra soha nem illett, most kettőt, mint a specifikáció szerint kell. A Linux-készlet olvasata nem változott (a `ruleset.json` és a `PROVENANCE.json` bájtra azonos);
- `OriginalFileName`: a program fájlneve (a `Image` utolsó tagja). Azt a nevet, amellyel a programot építették, az őr nem olvassa, ezért az átnevezett programot azok a szabályok nem látják, amelyek éppen ezt keresik.

**Esemény.** Egy parancsból egyszerű parancsonként egy esemény lesz: `Image` a program (útvonal marad, egy puszta név a `C:\Windows\System32\<név>.exe`, a `powershell` és a `pwsh` a szokásos helyük, egy cmdletnek nincs képe), `CommandLine` a parancs **szövege, ahogy megírták** (Windows is egy szövegként naplózza). A `cmd /c` és a `powershell -c` utáni parancsot még egyszer megvizsgáljuk. Ha az eszköz a **PowerShell**, a teljes parancs egy `powershell.exe -Command <parancs>` esemény is (ezért kapott a hook-hívás az eszköz nevét: `ToolCall.tool`); a `-Command` kapcsoló feltevés, az első változatban kapcsoló nélküli volt, és a `whoami` egy `.exe whoami` szabályon hamisan megszólalt. A Linux-készlet változatlan; minden shell-hívást mindkét készlet megvizsgál a maga eseményeivel (egy `nc -e` sort a Linux szabálya és a Windows `nc.exe`-szabálya is jelzi).

**Mérés.**

- 51 szokásos fejlesztői parancs (git, pnpm, PowerShell-cmdletek, `tasklist`, `whoami`, `cmd /c dir`, ...): **0 találat**.
- A repó saját 112 parancsa: 5 találat, mind ugyanaz a szabály (**Potential Defense Evasion Activity Via Emoji Usage In CommandLine - 4**), és mind dokumentációs diagramsor, nem valódi parancs. De a szabály a `→`-t és a csillag-jeleket is keresi, ezért egy valódi `git commit -m "a → b"` megszólalna: ez ismert hamis pozitív jelölt, a figyelmeztetés-napló mutatja majd, mennyire gyakori.
- 29 támadó-szerű parancs (PowerShell-letöltés és -kódolás, `mshta`, `bitsadmin`, `comsvcs.dll` memóriamentés, `reg save HKLM\SAM`, `vssadmin`, ...): **15-öt** jelzett. A 14 hiány: a `core` csomagnak nincs általános szabálya rájuk (a `certutil -urlcache`-ra csak a közvetlen IP-s és a fájlmegosztó-doménes változat van, ezt ellenőriztem), vagy szülőfolyamat kellene hozzá; a többinél az okot nem néztem meg külön. A találat nem ítélet: a szabályok `test` állapotúak (541 a 558-ból, 17 `stable`).
- Hostile bemenet: öt szándékosan rossz parancs (30 000 karakter, 5000 nyitó zárójel, ismétlődő kódolt sor, ...) mind a 350 szabályon összesen **~1,1 s** alatt lefutott, a leglassabb egyetlen bemenet 0,36 s (a parancs szövege 8000 karakterre vágva; a teszt 5 s-ot enged).

**Bekötés.** Ugyanaz, mint a Linux-készleté: `command-rulesets` kapu, **csak figyelmeztet**, a `.colony/ruleset-warnings.jsonl` rögzíti, a `rulesets-measure.mjs --commands` a Windows-készletet is méri. A blokkolás feltétele változatlan (két hét használat, szabályonkénti átnézés, külön jóváhagyás).

**Hátra van.** A Windows egyéb naplótípusai (rendszerleíró, fájl; a PowerShell-szkriptblokk a 6/h-ban) más eseményt igényelnek; a döntés, hogy a Windows-készlet minden gépen fusson-e, vagy csak Windowson (most mindenhol fut, mert egy Windows-szöveg egy Linux-gépen is jelzést ér).

## 6/h. A PowerShell-szkriptblokk szabályok (2026-11-19)

**Átvett anyag.** Ugyanaz a csomag (`sigma_core.zip` `r2026-07-01`, `sha256:45ccbd62…`; a te jóváhagyásoddal újra letöltve egy üres ideiglenes mappába, az SHA-256 egyezett): a `rules/windows/powershell/powershell_script` mappa **53** fájlja bájtra azonosan a `rulesets/sigma-powershell/` alatt, külön készletként (saját `PROVENANCE.json` és `NOTICE`, DRL 1.1). A csomag két másik PowerShell-mappáját (`powershell_module` 18, `powershell_classic` 4) nem vettem át.

**Átalakítás.** Mind az 53 szabály átjött, 0 maradt ki: egyetlen mezőt, a `ScriptBlockText`-et használják (`contains`, `all`, `re`, `startswith`), ez egy szkript szövege, amely egy futtatás előtti parancsnál megvan. Mind `status: test`. A készlet `ruleset.json`-jában új mező a `category: "ps_script"` (a loader ismeri; ami nincs benne, az folyamatindítás), a `sources.json` bejegyzésében és a frissítő szkriptben `category`, a konverterben `--category`.

**Esemény.** Egy parancsból `ScriptBlockText` események lesznek: (1) a PowerShell-eszköz hívása maga egy szkript; (2) a `powershell`/`pwsh` `-Command`/`-c` utáni szöveg bármelyik shell-hívásban; (3) a `-EncodedCommand` (`-e`, `-enc`) **megfejtett** szövege (base64 UTF-16LE), ha szövegnek látszik (a karakterek legalább 90%-a nyomtatható ASCII) — a szkriptblokk-napló is a megfejtett szöveget mutatja. Egy hívásból legfeljebb 20 szkript, egyenként legfeljebb 24 000 karakter; a hosszabbat levágjuk, tehát egy 24 000 karakternél hosszabb szkript vége nincs megvizsgálva (egy támadó kitöltéssel kikerülheti; ez figyelmeztetés, nem védelem).

**A `re` ablakai.** A reguláris kifejezés eddig a mező első 8000 karakterén futott; egy szkriptnél ez kevés, ezért most 8000 karakteres, 1000 karakterrel átfedő ablakokon fut, összesen legfeljebb 24 000 karakteren. A folyamatindítási szabályok parancsa eddig is legfeljebb 8000 karakter, azoknál semmi sem változott.

**Mérés.**

- 25 szokásos PowerShell-szkript (`Get-ChildItem`, `Remove-Item`, `Invoke-WebRequest`, `Compress-Archive`, `[Convert]::ToBase64String`, `gh pr checks`, ...): **0 találat**. A repó saját 112 parancsán nincs új találat.
- 16 támadó-szerű szkript (letöltési kradle, `Invoke-Mimikatz`, PowerView, `Set-MpPreference`, AMSI-kikapcsolás, árnyékmásolat törlése, ...): **9-et** jelzett. A 7 hiány okát nem néztem meg: lehet, hogy a példám nem tartalmazza a szabály mintáját, lehet, hogy a készlet nem fed le egy technikát.
- Egy kódolt parancs (`powershell -enc <base64>`, Bash-eszközből) a megfejtett szöveg alapján jelzett.
- Hostile bemenet: négy szándékosan rossz szkript (60 000 karakter, 20 000 nyitó zárójel, ismétlődő sorok, ...) mind az 53 szabályon **44 ms** alatt lefutott.

**Bekötés.** Ugyanaz, mint a többi parancs-készleté: `command-rulesets` kapu, **csak figyelmeztet**, a `.colony/ruleset-warnings.jsonl` rögzíti, a `rulesets-measure.mjs --commands` méri. A blokkolás feltétele változatlan.

**A másik két PowerShell-mappa, és miért maradt ki (2026-11-20, a csomagot megnéztem, nem vettem át).** A `powershell_module` 18 szabálya (`ps_module`) a modul-naplózás `Payload` és `ContextInfo` mezőjére épül; 13-nak a `powershell_script` mappában azonos című megfelelője van, és már átvettük (a címek egyeztek, a tartalmat nem hasonlítottam össze). A `Payload` a modulnapló formázott bejegyzése (parancsmeghívás paraméter-kötésekkel), a `ContextInfo` a gazdaalkalmazás és a felhasználó adatai: ezek egy futtatás előtti parancsnál nincsenek meg, a nyers szkript szövege pedig más szöveg, mint a `Payload`, ezért a leképezés megbízhatatlan lenne. A `powershell_classic` 4 szabálya (`Data` mező) a PowerShell-motor állapotsorait olvassa (`HostApplication=...`), ez sem létezik egy parancs előtt. Egyiket sem érdemes átvenni, amíg nem lesz valódi napló-forrás.

**Hátra van.** A fájl-szabályok (más eseménytípus); a szkriptfájlok tartalma (egy `powershell -File x.ps1` fájlját nem olvassuk).

## 6/i. A rendszerleíró-szabályok (2026-11-20)

**Átvett anyag.** Ugyanaz a csomag (`sigma_core.zip` `r2026-07-01`, `sha256:45ccbd62…`, a korábban letöltött és ellenőrzött példány): a `rules/windows/registry` mappa **125** fájlja (100 `registry_set`, 3 `registry_delete`, 22 `registry_event`) bájtra azonosan a `rulesets/sigma-registry/` alatt, külön készletként (DRL 1.1, saját `PROVENANCE.json` és `NOTICE`). Ebben a mappában más típusú szabály nincs.

**Átalakítás.** 125-ből **117 jött át**, 8 kimaradt indokkal (3 olyan mezőt kér, amely egy parancsnál nincs, 5 üres vagy nem szöveges értéket tartalmaz). Egy rendszerleíró-esemény mezői közül négyet adunk: `TargetObject`, `Details`, `Image`, `EventType`; az `NewName` (átnevezés) nincs, az ilyet kérő szabály kimarad. Minden szabály megjegyzi, milyen eseményre készült (`on`: `registry_set`, `registry_delete` vagy `registry_event`, ez utóbbi bármelyikre); egy törlés-szabály egy beállítás-eseményre nem illik. A készlet `ruleset.json`-jában `category: "registry"`.

**Esemény.** Csak azokból a parancsokból, amelyek a sorból láthatóan a rendszerleírót írják: `reg add` és `reg delete`, és a `Set-ItemProperty`, `New-ItemProperty`, `Remove-ItemProperty` (alias: `sp`, `rp`) rendszerleíró-útvonalon, a `cmd /c` és `powershell -c` utáni parancsban is. Egy `reg add` érték-írás (`SetValue`), kulcs-létrehozás (`CreateKey`, ha nincs `/v` és `/ve`), a `reg delete` érték- vagy kulcstörlés. **Feltevések:** a `TargetObject` a kulcs és az érték neve (`HKLM\...\Név`); a `HKCU` helyén `HKU\S-1-5-21-0-0-0-1000` áll (a Sysmon a felhasználó SID-jét naplózza, ezt az őr nem ismeri); a DWORD és QWORD adat úgy van írva, ahogy a Sysmon kiírja (`DWORD (0x00000001)`), a bináris `Binary Data`, hiányzó adat `(Empty)`; egy számjegyes PowerShell-érték típus nélkül DWORD. **Nem látja:** a `reg import` fájlját, a szkriptfájlokat, a futáskor épülő útvonalakat, a `New-Item` kulcs-létrehozást és a `.reg` fájl megnyitását. Egy hívásból legfeljebb 50 esemény.

**Mérés.**

- 15 szokásos parancs (`reg query`, HKCU-beállítások, `Set-ItemProperty` a témára és a háttérre, `reg delete`, `LongPathsEnabled`, `git status`, ...): **0 találat** (ebből 10-ből lett rendszerleíró-esemény). A repó saját 112 parancsán nincs új találat.
- 14 támadó-szerű parancs (Defender kikapcsolása, WDigest, RestrictedAdmin, Sticky Keys hátsó ajtó, `ms-settings` UAC-kerülés, Run-kulcs, `EnableLUA`, RDP bekapcsolása, tűzfal kikapcsolása, ...): **6-ot** jelzett. A 8 hiány okát nem néztem meg; a core csomag általános Run-kulcs- vagy `EnableLUA`-szabályát nem találtam, de ezt nem ellenőriztem szabályonként.
- Hostile bemenet: három szándékosan rossz parancs (50 000 karakteres, 1000 összefűzött `reg add`, ismétlődő útvonal) mind a 117 szabályon **~0,5 s** alatt lefutott.

**Bekötés.** Ugyanaz, mint a többi parancs-készleté: `command-rulesets` kapu, **csak figyelmeztet**, a `.colony/ruleset-warnings.jsonl` rögzíti. A blokkolás feltétele változatlan.

**Hátra van.** A `reg import` és a szkriptfájlok tartalma. (A fájl-szabályok a 6/j-ben.)

## 6/j. A fájl-szabályok (2026-11-20)

**Átvett anyag.** Ugyanaz a csomag (`sigma_core.zip` `r2026-07-01`, `sha256:45ccbd62…`): a `rules/windows/file` mappa **91** fájlja (87 `file_event`, 3 `file_delete`, 1 `file_change`) bájtra azonosan a `rulesets/sigma-file/` alatt, külön készletként (DRL 1.1, saját `PROVENANCE.json` és `NOTICE`). A Linux `file_event` mappa (2 szabály) nincs benne: ahhoz nincs Linux-oldali eseményépítő.

**Átalakítás.** 91-ből **86 jött át**, 5 kimaradt indokkal (`User`, `CommandLine` vagy `ParentImage` kell hozzá, ami egy fájlírásnál nincs). Egy fájl-esemény mezői közül kettőt adunk: `TargetFilename` és `Image`. Minden szabály megjegyzi a saját eseménytípusát (`on`: `file_event`, `file_delete`, `file_change`); egy létrehozás-szabály törlésre nem illik. A `ruleset.json`-ban `category: "file"`. A matcher nem változott: az `on` ellenőrzés a rendszerleíró-szabályoké volt.

**Esemény** (`src/rulesets/file-events.ts`). Amit a sor láthatóan fájlba ír: átirányítás (`>`, `>>`), `Out-File`, `Set-Content`, `Add-Content`, `New-Item`, `Copy-Item`/`Move-Item`, `copy`, `move`, `xcopy`, `robocopy`, `ren`, `expand`, `tee`, letöltés `-OutFile` vagy `-o` kapcsolóval (`Invoke-WebRequest`, `curl`, `wget`), `certutil -urlcache`/`-decode`, `bitsadmin /transfer`; törlés (`del`, `erase`, `rm`, `Remove-Item`) `file_delete` eseményként; a `cmd /c` és `powershell -c` utáni parancs is. A Write/Edit eszköz egy fájlja egy `file_event`, **`Image` nélkül** (a gazdaprogramot a szabályok nem ismerik). **Feltevések:** a relatív útvonal a munkakönyvtárból indul; a `%TEMP%`, `$env:APPDATA` és társai egy `user` nevű felhasználó mappáivá bővülnek (a valódi profilt az őr nem ismeri); az `Image` átirányításnál `cmd.exe`, parancsmagnál `powershell.exe`; a `file_change` eseményt (fájlidő-változás) az őr sosem építi, így az ilyen szabály itt nem egyezik. **Nem látja:** az írt adatot, a szkriptfájlokat, a futáskor épülő útvonalakat. Egy hívásból legfeljebb 100 esemény.

**Mérés.**

- 26 szokásos parancs (átirányítás a munkamappába, `Set-Content`, `copy`, `xcopy`, `del`, `Remove-Item`, `curl -o`, írás a `%TEMP%`-be, ...): **0 találat** (20-ból lett fájl-esemény). 10 szokásos Write-útvonalon (`src/a.ts`, `package.json`, `.github/workflows/ci.yml`, `a.ps1`, `run.bat`, ...) **0 találat**. A repó saját parancsain nincs új találat.
- 18 támadó-szerű parancs (írás a `C:\Users\Public`, `C:\PerfLogs` mappába, `certutil` letöltés és dekódolás, SAM másolása, `.hta` írása, ...): **6-ot** jelzett. A 12 hiány (Startup-mappa, `bitsadmin`, `Invoke-WebRequest`, webshell az `inetpub`-ba, `ntds.dit`) nagyrészt azért marad el, mert a szabály egy meghatározott írót vár (`Image`: Office, `w3wp.exe`, ...), mi pedig `cmd.exe`-t vagy `powershell.exe`-t adunk; szabályonként nem ellenőriztem.
- Hostile bemenet: 50 000 karakteres útvonal, 1000 összefűzött átirányítás, ismétlődő útvonal mind a 86 szabályon **~0,4 s** alatt lefutott.

**Bekötés.** A `command-rulesets` kapu, **csak figyelmeztet**, a `.colony/ruleset-warnings.jsonl` rögzíti. Új: a pretool kapu a Write/Edit eszköz útvonalát is átadja a fájl-szabályoknak (`checkFileWriteWithRulesets`); az írt szöveg a titokszabályoké marad. A blokkolás feltétele változatlan.

**Hátra van.** A fájl-szabályok Linux oldala (2 szabály), a `file_change`, az írt tartalom és a szkriptfájlok.

## 6/k. A külső audit B05 és A02 megállapításának javítása (2026-11-20)

**B05, a horgony és az ablak.** A reguláris kifejezés egy hosszú mezőn ablakonként fut; az ablak széle így `^`-ként vagy `$`-ként viselkedhetett. Most a kifejezés megjegyzi, a mező melyik végéhez köti (`^`, `$`; az escape-elt és a karakterosztályon belüli jel nem horgony): a kezdethez kötött az első ablakon, a véghez kötött a **valódi mező** utolsó ablakán (a 24 000 karakteres olvasási határon túl is) fut, a mindkettőhöz kötött egy ablaknál hosszabb mezőn nem egyezik (nem ítélhető meg). A `m` jelzős kifejezés sorokhoz köt, ezt egy ablak nem tudja megkülönböztetni a mezőtől: ez az egyetlen eset, amely közelítő marad. A 49 `re` értékből jelenleg 6 véghez kötött (mind fájlnév-végződés), kezdethez köttött és `m` jelzős nincs.

**A02, egy hibaszabály az útvonalakra.** A két útvonalfeloldó (`src/safe-path.ts` aszinkron és a shell-ellenőrzés szinkron változata, most közös szabállyal) eltérően kezelte a hibákat. Most: ami nincs ott (`ENOENT`, `ENOTDIR`), azt a szülőjén át oldja fel; egy **lógó link** (olyan, amely nem létező helyre mutat) arra a helyre vezet, ahová mutat, mert egy írás rajta át azt hozná létre (korábban egy projekten kívülre vagy a `.colony`-ba mutató lógó linken át a fájlírás áthaladt: kódolvasásból igazolt, a régi kódon nem futtattam); minden más hiba (jogosultság, linkhurok, ...) `SafePathError(UNRESOLVABLE)`, vagyis az ismeretlen állapotot nem a név szövege alapján ítéli meg. A fájl-eszköz ilyenkor megtagad, a shell-ellenőrzés a projekten belüli útvonalra rákérdez (`ask`). **Nem védett:** az ellenőrzés és a host művelete közötti időrés (egyidejű útvonalváltoztatás).
## 6/l. A mérőszkript javítása (külső audit C01, C02; 2026-11-20)

**C01, a személyes adatok összevetése.** A „saját minták" oszlop korábban a Presidióval már kibővített kitakarót használta, és bármilyen részleges kitakarást találatnak vett: a Presidio bekötése óta ezért a saját minták „találata" a készlet találatát is jóváírta (a 10 MAC-találatból mind a tízet, pedig a saját mintáknak nincs MAC-szabálya). Most az alap **rögzített**: `redactText(…, { builtinOnly: true })` és `findRedactSpans`, vagyis csak a beépített minták, a készletek nélkül; egy találat akkor „azonos", ha a fajtája és pontosan ugyanazok a karakterei egyeznek (`sameByBuiltin`), „részben", ha az alap valami átfedőt talál (`partlyByBuiltin`), különben csak a készlet találta (`onlyByRuleSet`). A mérés megnevezi magát (`pii-compare v2`). **Mai szám** (162 fájl: `src`, `docs`, `scripts`, két gyökér-Markdown, két Guard JSON): 109 találat, ebből azonos 57, részben 10, csak a készlet 42; a MAC-címből 12 van, a beépített alap egyet sem talál. A korábbi, a 6/b–6/c szakaszban közölt „közös/csak készlet" számokat ezért a régi mérés verziójának számokként kell olvasni, nem a mostaniéinak.

**C02, a parancsok mérése.** A mérő korábban minden Markdown-kódblokk minden sorát parancsnak vette. Most csak az a parancs, ami (1) egy shellnek jelölt blokk sora (`sh`, `bash`, `powershell`, `console`, …), (2) egy munkafolyamat `run:` sora, (3) egy `package.json` szkriptje; a többi kódsort külön számolja (`otherCodeLinesNotJudged`), és csak `--all-code`-dal ítéli meg. A jelentés külön közli: a mintát (`sample.id`: a minta tartalmának hash-e, `--sample-out` kiírja a mintát), a parancsok számát forrásonként, hány parancshoz épült esemény fajtánként, a találatok számát, és a **találatokat az értékelés szerint**: `--ratings` fájllal (fájl, sor, szabály, `false-positive` vagy `true-positive`) az emberi döntést olvassa; amit senki nem értékelt, az `unrated`, nem hamis és nem igaz. **Mai szám** (`README.md ROADMAP.md docs .github package.json`): 31 parancs (21 shell-blokk, 4 munkafolyamat, 6 szkript), 99 egyéb kódsor, 0 találat a parancsokon; a korábbi 5 találat mind egyéb kódsorban volt (ábrák). **Hiba, amit ez derített ki:** a mérő a sorokat csak a sortörésnél (`\n`) bontotta, a Windowson kiolvasott munkafolyamat sorvége CRLF, így a `run:` sorok ezen a gépen egyáltalán nem számítottak; most `\r?\n` a bontás.

## 7. Szeletek

| # | Szelet | Állapot |
|---|---|---|
| 1 | **Titokminták:** gitleaks v8.30.1 átvétele, betöltő, hash-ellenőrzés, átalakító, frissítő szkript, mérés, beillesztés | átvétel, átalakító, betöltő, kereső, mérés, a **jelzésként való bekötés** és a **frissítő szkript** kész; a blokkolás hátra van (a tervben rögzített feltétel után) |
| 2 | **Személyes adatok:** a presidio 2.2.366 mintáinak átvétele a kitakaráshoz (IP-cím, IBAN, bankkártya, MAC-cím; a magyar adószám, TAJ, bankszámla és az e-mail, telefon marad saját) | átvétel, Python-minta-kinyerő, átalakító, betöltő, ellenőrzők, mérés **kész**; a kitakarásba kötés hátra van (külön jóváhagyás) |
| 3 | **Veszélyes parancsok:** a **Sigma** (DRL 1.1) `core` csomagjának Linux folyamatindítási szabályai, **csak jelzésként** (6/e) | az átvétel, a YAML- és ZIP-olvasó, a kiértékelő, a betöltő, a kapu és a mérés **kész**; a frissítő szkript ZIP-módja és a Windows-szabályok (6/g) is **kész**; a blokkolás hátra van. A saját `DESTRUCTIVE` tábla marad |
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
