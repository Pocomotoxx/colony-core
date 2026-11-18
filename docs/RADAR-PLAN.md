# Radar terv: külső jelek a fejlesztő környezetéről

Állapot: **az első szelet megírva, hamis feed-szerverrel tesztelve, és egyszer valódi hálózati futással kipróbálva (`scripts/radar-fetch.mjs`, 25 elem, 5 tároló).** A `radar import`, a forráslista levezetése és a briefing-integráció még terv. Ami nincs igazolva, azt a "Nyitott kérdések" fejezet sorolja fel.

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

## Parancsok (tervezettek)

| Parancs | Mit csinál |
|---|---|
| `radar sources` | A `package.json`-ból levezetett, javasolt forráslista; a fejlesztő hagyja jóvá. |
| `radar import <fájl>` | A letöltő szkript kimenetét beolvassa, szűri, deduplikálja és tárolja. Hálózatot nem használ. |
| `radar list [--project P]` | A friss, nem lejárt jelek. |
| `radar forget --expired` | A lejárt jelek törlése. |

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
- **Nincs benne (még):** a `radar import`, `list` és `forget` parancs a magban, a forráslista levezetése a `package.json` fájlból, lejárat, és a briefing-integráció. Egy valódi futás volt (lásd lent).

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
2. **`radar import`, `list`, `forget`** tesztekkel (mintaadatokkal, hálózat nélkül), beleértve a hostile szöveg elutasítását és a lejárat tesztjét.
3. **Briefing-integráció:** a friss, projekthez tartozó jelek megjelennek a `start` és a `next` kimenetében, megjelölve.
4. **Biztonsági figyelmeztetések forrása.**
5. **Mérés** az eval keretben; ez dönti el, hogy a radar alapértelmezett lesz-e.

## Nyitott kérdések (nem igazolt)

- A GitHub Atom feedek és a biztonsági adatbázisok pontos formátuma és kérésgyakorisági korlátai.
- Mennyire megbízható a `scan` egy valós, külső szövegen: erre külön tesztkészlet kell.
- Valóban javítja-e a radar a munkát a fejlesztő saját projektjein.
- Mi legyen a jelekkel akkor, ha a host nem tudja futtatni a letöltő szkriptet (például a Coworkben).

## Szolgáltató

A kivonatolás és a védelem külső szolgáltatóval (Groq) fut, csak nyilvános szöveggel, zárt hiba mellett: [PROVIDER-PLAN.md](PROVIDER-PLAN.md).
