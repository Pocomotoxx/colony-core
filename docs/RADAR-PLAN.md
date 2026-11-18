# Radar terv: külső jelek a fejlesztő környezetéről

Állapot: **az első szelet megírva, hamis feed-szerverrel tesztelve, és egyszer valódi hálózati futással kipróbálva (`scripts/radar-fetch.mjs`, 25 elem, 5 tároló).** A `radar import`, `list` és `forget` parancs a magban megvalósítva és tesztelve, a `next` kimenete címkézett `externalSignals` mezőt kap; a forráslista levezetése a `package.json` fájlból és a valódi használat mérése még hátravan. Ami nincs igazolva, azt a "Nyitott kérdések" fejezet sorolja fel.

## Cél

A fejlesztő projektjét érintő külső változásokat (függőségek kiadásai, biztonsági figyelmeztetések, a használt futtatókörnyezet változásnaplói) időben a fejlesztő elé hozni, forrással és dátummal, igazolatlanként megjelölve.

## Nem cél

- **Nem általános hírolvasás.** Az általános hírek zajt adnak, és a fejlesztő munkájához nem kapcsolódnak.
- **Nem tanítás.** A modell súlyai és az ügynökprofilok nem változnak attól, hogy olvasnak. A radar jegyzeteket ad, amelyek a briefingben megjelennek, és nem alakítják át az ügynököket.
- **Nem része a magnak.** A mag nem használ hálózatot, nulla futásidejű függőséggel dolgozik, ezt teszt őrzi. A letöltés külön szkript.

## Elvek

1. **Opt-in és szűk lista.** A források a projekt `package.json` fájljából vezethetők le, és a fejlesztő hagyja jóvá a listát. Semmi nem kerül a listára automatikusan.
2. **Külső adat = nem megbízható adat.** Minden letöltött szöveg átmegy az injekciószűrőn (`scan`) és a kitakaráson (`redact`), mielőtt a modell vagy a memória megkapja.
3. **Igazolatlan, forrással.** Minden jel hordozza a forrás URL-jét és a letöltés idejét, és "külső jel, nem igazolt" címkével jelenik meg.
4. **Nem tanulási adat.** A jelek külön névtérbe (`signals`) kerülnek. A Reasoning Bank-be nem mehetnek, mert oda csak értékelt munka kerülhet.
5. **Teljes cikk helyett kivonat és link.** Jogilag és tárolásilag is tisztább.
6. **Mérés.** A radar addig nem lesz alapértelmezett, amíg nem látszik, hogy segít (lásd az [EVAL-PLAN.md](EVAL-PLAN.md)-t).

## Források (kezdeti, szűk lista)

| Forrás | Mire jó |
|---|---|
| GitHub kiadások (Atom feed) a projekt függőségeihez | új verziók, breaking change |
| Biztonsági figyelmeztetések (például GHSA vagy OSV) a projekt függőségeire | ismert sérülékenységek |
| Node és TypeScript változásnaplók | futtatókörnyezeti változások |

A forrás pontos formátumát és elérhetőségét a megvalósítás előtt le kell ellenőrizni, ezek jelenleg feltételezések.

## Felépítés

```
scripts/radar-fetch.mjs   (hálózat itt van, a magon kívül, kézzel indítva)
        │  nyers feed-elemek
        ▼
  scan + redact           (a meglévő injekciószűrő és kitakarás)
        │  megszűrt elemek
        ▼
  radar import            (a mag csak fájlt olvas, hálózatot nem)
        │
        ▼
  memória: névtér `signals`  →  briefing: "külső jel, nem igazolt, forrás: …"
```

Minden `signals` bejegyzés mezői: `source` (URL), `fetchedAt`, `expiresAt`, `project` (melyik függőséghez tartozik), `summary` (rövid kivonat), `hash` (a duplikáció kizárására).

## Parancsok

| Parancs | Állapot | Mit csinál |
|---|---|---|
| `radar sources` | **terv** | A `package.json`-ból levezetett, javasolt forráslista; a fejlesztő hagyja jóvá. |
| `radar import <fájl> [--ttl-days N] [--project NÉV]` | **megvalósítva** | A `scripts/groq-summarize.mjs --out` kimenetét olvassa: csak a `ok` státuszú, https forráslinkes elemeket tárolja (a többit `skipped` néven felsorolja), a szöveget újra átvizsgálja (hostile: elutasítja és naplózza) és kitakarja (a verziószámok kivételével). Ugyanaz az azonosító frissít, nem duplikál. Hálózatot nem használ. |
| `radar list [--project P] [--k N] [--include-expired]` | **megvalósítva** | A jelek címkével, forrással, idővel és lejárattal; alapból a lejártak nélkül. |
| `radar forget <id> \| --expired \| --all` | **megvalósítva** | Törlés. |

A jelek a `signals` névtérben vannak, **a szokásos felidézésbe nem keverednek** (a keresés `excludeNamespaces` opciót kapott). A `next` kimenetének `externalSignals` mezője legfeljebb hármat mutat, mindegyiket "nem igazolt" címkével, forrással és a `why` indokkal:

1. **A feladat névvel említi a projektet** ("eslint", "Node.js", "pnpm"): a projekt legfrissebb jelei, a hasonlóságtól függetlenül. A projekt neve a tároló neve, szó egészként (a `nodemailer` nem `node`), az általános nevek (`core`, `app`, `lib`...) és a 3 karakternél rövidebbek nem számítanak.
2. **Hasonló szöveg:** a jel szövege hasonlít a feladathoz (a hasonlósági küszöb, 0,25, **kalibrálatlan**), a `why` mutatja a pontszámot.

A tárolt szöveg elején a **projekt és a kiadás címkéje** áll, mindkettő a forráslinkből származik (nem a modell írja), mert a kivonatok gyakran nem nevezik meg a projektet ("Version 10.15.0 adds…"), a keresés pedig a szöveget olvassa. A `radar list` és a `next` a tiszta kivonatot mutatja.

## Költség

- **Letöltés:** csak hálózati forgalom, tokent nem fogyaszt.
- **Összefoglalás:** tokent fogyaszt, ezért: deduplikálás hash alapján, már látott tétel kihagyása, napi korlát a feldolgozott tételekre.
- **Tárolás:** lejárattal és törléssel korlátos.
- **Becslés:** `eval`-hoz hasonlóan a futtatás előtt becslés készül, és kemény keret védi (lásd az EVAL-PLAN költségfejezetét). A tényleges számokat egy próbafutás méri, ebben a tervben nincs mért adat.

## Kockázatok

| Kockázat | Védelem |
|---|---|
| Prompt injection egy feedből | `scan` és `redact` minden elemen; a gyanús elem el is utasítható; a jel mindig adatként kerül a modell elé |
| Hamis vagy elavult jel | forrás és dátum minden jelnél, lejárat, "nem igazolt" címke |
| A modell összefoglalója téved | kivonat és link, az eredeti elérhető; az összefoglaló sosem kerül a tanuló memóriába |
| Memória szennyeződése | külön névtér, lejárat, a Reasoning Bank-től elkülönítve |
| Adatvédelem | a letöltés elárulhatja az IP-címet és az érdeklődést; a lista a fejlesztő döntése, és csak a projektből levezetett források szerepelnek rajta |
| Jogi kérdés | csak rövid kivonat és hivatkozás, nem a teljes cikk |
| Zaj | szűk, projektből levezetett lista; csak a projektet érintő jelek jelennek meg |

## Mérés

Az [EVAL-PLAN.md](EVAL-PLAN.md) szerint: radarral és anélkül, ugyanazokon a feladatokon és projekteken. Lehetséges mutatók: mennyi idő alatt derül ki egy elavult vagy sérülékeny függőség, hány javítandó hiba marad a feladat végén. Ha a radar haszna nem mérhető, nem marad be alapértelmezettnek.

## Megvalósítás: az első szelet (`scripts/radar-fetch.mjs`)

Egyetlen forrás: a megadott GitHub-tárolók kiadási jegyzetei (`https://github.com/<tulajdonos>/<tároló>/releases.atom`). Külön szkript a magon kívül (a mag nem használ hálózatot). A célja kettős: a radar első adatforrása, és **valódi, ártalmatlan szöveg** a szűrőlánc téves jelzési arányának méréséhez (a kitalált mintákon ez ismeretlen maradt).

```
node scripts/radar-fetch.mjs --dir <projekt> --repos tulajdonos/tároló,... --dry-run
node scripts/radar-fetch.mjs --dir <projekt> --repos tulajdonos/tároló,... --yes
```

- **Csak a megnevezett tárolók feedjei:** más gazdagép nincs, átirányítást nem követ, nincs bejelentkezés és süti, az `User-Agent` általános (`colony-radar/1.0`), feedenként 1 MB és 20 másodperc a korlát, legfeljebb 20 tároló egy futásban. A gazdagép csak a GitHub vagy egy loopback cím lehet (utóbbi a teszteknek). `--yes` nélkül nem hív hálózatot, a `--dry-run` csak az URL-eket listázza.
- **Szöveggé alakítás:** a blokk-címkék sort törnek, a sorközi címkék eltűnnek (így a `ign<b>ore</b>` is `ignore`-ként olvasódik), a script- és style-blokkok kimaradnak, az entitások feloldódnak.
- **Kétszeri szűrés:** a szöveget úgy is átvizsgálja, ahogy megérkezett (HTML-megjegyzésekkel és rejtett részekkel), és sima szövegként is, a HTML-megjegyzések tartalmát külön. A `hostile` elem **karanténba** kerül (a jelentésben szerepel, a fájlba nem), a személyes adat kitakarva kerül a fájlba.
- **Kimenet:** `<projekt>/.colony/radar/items.json` (`id`, `source`, `text`), ezt olvassa a `scripts/groq-summarize.mjs`. A már látott elemeket (`.colony/radar/seen.json`) kihagyja, `--all` nélkül.
- **Jelentés:** feedenként állapot, összesítés (hány tiszta, gyanús, hostile, HTML-megjegyzéssel, kitakart), és a karanténba tett elemek forrása, oka és egy rövid, **nem megbízható** idézete. Release-jegyzet hétköznapi szöveg, ezért minden karanténba tett elem megnézendő: lehet téves jelzés.
- **Tesztek:** 9 teszt hamis feed-szerverrel (valódi hálózat nélkül): URL-ek és `--yes`, szöveggé alakítás és forráslink, hostile és megjegyzésbe rejtett utasítás karanténba, gyanús elem megjelölése és kitakarás, látott elem kihagyása, hibás feed és átirányítás, 1 MB-nál nagyobb feed, tiltott gazdagép és hibás tárolónevek, a kimenet olvashatósága a Groq-kivonatolónak.
- **Nincs benne (még):** a forráslista levezetése a `package.json` fájlból, a lejárt jelek automatikus törlése (jelenleg `radar forget --expired`), és az, hogy a `start` kimenete is mutasson jeleket. A `radar import` és a `next` integrációja megvalósult, lásd a Parancsok fejezetet. Egy valódi hálózati futás volt (lásd lent).

## A teljes lánc (kézzel indítva, minden lépés külön jóváhagyással)

```
node scripts/radar-fetch.mjs --dir <projekt> --repos tulajdonos/tároló,... --yes
node scripts/groq-summarize.mjs --dir <projekt> --in .colony/radar/items.json --yes --out .colony/radar/summaries.json
node dist/cli.js radar import .colony/radar/summaries.json --dir <projekt>
```

1. **Letöltés és szűrés** (hálózat: csak a megnevezett GitHub-feedek). Karantén: a hostile elem.
2. **Guard és kivonat** (Groq, csak nyilvános szöveg). Karantén: amit a Guard jelez, vagy ami hibára fut (zárt hiba). A `--out` UTF-8 fájlt ír (a PowerShell `>` átirányítása UTF-16-ot írna, azt semmi nem olvassa), és a `--out` útvonalát a szkript **az első hívás előtt** ellenőrzi. Minden eredmény viszi a forráslinkjét.
3. **Import a magba** (hálózat nélkül): csak a `ok` státuszú, forráslinkes elem kerül be, a szöveg újra átmegy a `scan`-en és a kitakaráson.

Az eredeti elem sorsa a lánc minden pontján látható: `radar-fetch` jelentése (karantén), a kivonatoló `results` listája (`quarantined`, `deferred`, `failed`), az import `skipped` és `refused` listája.

## Mért adatok: milyen jeleket kap egy feladat (2026-11-18)

A 25 valódi jel (5 projekt) a próbamappában, 8 **új** feladattal, amelyeket a keresés módosítása **előtt** rögzítettem (öt név szerint említ egy projektet, három független):

| | Jó találat (5 említett projekt) | Helyes "nincs jel" (3 független) | Téves jelzés |
|---|---|---|---|
| Előtte (csak hasonló szöveg, 0,25-ös küszöb) | 2 | 2 | 1 |
| Utána (projektnév + fejléc a szövegben) | **5** | 2 | 1 |

- **Mi volt a hiba:** a releváns jelek hasonlósági pontszáma (0,16–0,24 az ESLint, a pnpm és a vitest feladatnál) alig különbözött a független feladatokétól (0,14–0,17), ezért **semmilyen küszöb nem választotta szét őket**; a kivonatok gyakran nem is nevezik meg a projektet. A rangsor viszont jó volt (az 1–2. helyen álltak).
- **Mi marad:** az "Onboarding docs" feladat egy ESLint-jelet kapott a hasonló szöveg útján (0,270, a "documentation updates" szavak miatt, a küszöb 0,25), a többi független feladat legfeljebb 0,17-et ért el. A küszöböt **nem módosítottam**, mert csak ezeken a feladatokon hangolnám; a téves jelzés ára egy címkézett, irreleváns jel.
- **Korlátok:** 8 feladat, mindet én írtam, a jeleket ismerve; a projektnév-találat a tárolók neveire épül (az ismertebb nevek, mint a `node`, tágabban értelmezhetők); a hasonlósági útnak valódi, külső feladatszövegeken kell kalibrálás. Nem mértük, hogy a jelek **segítik-e** a munkát: az eval-keretben mérhető (lásd [EVAL-PLAN.md](EVAL-PLAN.md)).

## Mért adatok: az első valódi futás (2026-11-17)

Öt nyilvános tároló kiadási jegyzetei (`nodejs/node`, `microsoft/TypeScript`, `pnpm/pnpm`, `eslint/eslint`, `vitest-dev/vitest`, feedenként 5), 25 elem, a hívás csak a GitHubra ment, kulcs nélkül.

| | Eredmény |
|---|---|
| Tiszta / gyanús / hostile (helyi `scan`) | 25 / 0 / 0 |
| HTML-megjegyzéssel | 0 |
| Kitakart elem | 1 (lásd lent) |
| Hosszú elem (a 4000 karakteres korlátot elérte) | 6 |

- **Téves jelzés valódi szövegen:** a helyi szűrő 25 elemből egyet sem jelzett. A Guard a 24 elemen, amelyen választ adott, 0,0004 és 0,0213 közötti pontszámot adott (0 tévesen jelzett 0,5-nél). A **0,01-es küszöb** 4 / 24 valódi jegyzetet (17%) jelzett volna, ez a küszöb elvetését valódi adattal is megerősíti. A minta kicsi (25 elem, egyetlen szövegtípus: fejlesztői kiadási jegyzet), ez nem általános arány.
- **Szöveggé alakítás:** valódi adaton is olvasható szöveget ad. A `<pkg>` és `<id>` helyőrzők, valamint egy szerző által írt `&#39;` karaktersorozat az eredeti szöveg része, nem alakítási hiba.
- **Hiba, javítva:** egy négy számcsoportos verziószám (`13.6.233.17`, a V8 verziója) IP-címnek számít, és a kitakarás eltüntette, így a kivonat "a V8 patch"-et írt verzió nélkül. A kitakarás kapott egy szűk, opt-in kihagyást (`skip: ['ip_address']`, titkot soha nem lehet kihagyni), a radar elemei `redactSkip: ["ip_address"]` jelzést kapnak, és a kivonatoló csak ezt az egy fajtát fogadja el.
- **Kitakarás, ami nem hiba:** az e-mail-címek és a többi személyes adat továbbra is kitakarva kerül a fájlba.

## Fázisok

1. **Letöltő szkript kézzel**, egy forrással (például egy függőség GitHub-kiadásai), a kimeneti formátum rögzítésével.
2. **`radar import`, `list`, `forget`** tesztekkel (mintaadatokkal, hálózat nélkül), beleértve a hostile szöveg elutasítását és a lejárat tesztjét. **Kész.**
3. **Briefing-integráció:** a friss, a feladathoz közeli jelek megjelennek a `next` kimenetében, megjelölve (**kész**); a `start` kimenete még nem mutat jeleket.
4. **Biztonsági figyelmeztetések forrása.**
5. **Mérés** az eval keretben; ez dönti el, hogy a radar alapértelmezett lesz-e.

## Nyitott kérdések (nem igazolt)

- A GitHub Atom feedek és a biztonsági adatbázisok pontos formátuma és kérésgyakorisági korlátai.
- Mennyire megbízható a `scan` egy valós, külső szövegen: erre külön tesztkészlet kell.
- Valóban javítja-e a radar a munkát a fejlesztő saját projektjein.
- Mi legyen a jelekkel akkor, ha a host nem tudja futtatni a letöltő szkriptet (például a Coworkben).

## Szolgáltató

A kivonatolás és a védelem külső szolgáltatóval (Groq) fut, csak nyilvános szöveggel, zárt hiba mellett: [PROVIDER-PLAN.md](PROVIDER-PLAN.md).
