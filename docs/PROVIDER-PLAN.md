# Szolgáltató terv: Groq a külső szövegek feldolgozására

Állapot: **az adapter megírva és hamis szerverrel tesztelve, valódi Groq-hívás még nem történt.** A keretek a fejlesztő által a Groq konzolról bemásolt értékek, **nem ellenőriztem őket**. Ami nincs igazolva, azt a "Nyitott kérdések" fejezet sorolja fel.

## Szabály

Az **önképzés** (olvasás, kivonatolás, előszűrés, védelem) mehet külső, ingyenes API-ra. A **munka** nem: az a fő modellen (a hoston) marad. Az eval-futások is a fő modellen futnak, mert a mérés egy host-modell párra érvényes, és egy másik modellen mért eredmény nem mond semmit a fő modell viselkedéséről ([EVAL-PLAN.md](EVAL-PLAN.md)).

## Mit kap és mit nem a szolgáltató

- **Csak nyilvános szöveg megy ki:** feed-elemek, abstractok, kiadási jegyzetek ([RADAR-PLAN.md](RADAR-PLAN.md), [RESEARCH-PLAN.md](RESEARCH-PLAN.md)).
- **A projekt fájljai, a fejlesztői profil és bármi privát soha.** A letöltő szkript nem olvashat a projektmappából, és a kimenő szövegen is fut a `scan` és a `redact`.
- **A mag nem használ hálózatot.** A hívás külön szkriptben van (`scripts/`), kézzel indítva, a mag csak a kimenetet olvassa be.

## Szolgáltató és szerepek

Egyetlen szolgáltató az első lépésben: **Groq.** Két szerepe van, mindkettő adapter mögött, hogy a szolgáltató cserélhető legyen.

| Szerep | Modell | Feladat |
|---|---|---|
| Védelem | `meta-llama/llama-prompt-guard-2-86m` | Második vélemény: prompt injectionnek vagy jailbreaknek látszik-e a külső szöveg. A helyi `scan` mellé, nem helyette. |
| Kivonatolás | `openai/gpt-oss-120b` | Rövid kivonat egy abstractból vagy feed-elemből. A modell az OpenAI nyílt súlyú modellje, a Groq szerverein fut. |

### Keretek (a fejlesztő által megadott értékek)

| Modell | Kérés | Token |
|---|---|---|
| Prompt Guard 2 86M | 30 / perc, 14,4 ezer / nap | 15 ezer / perc, 500 ezer / nap |
| GPT OSS 120B | 30 / perc, 1000 / nap | 8 ezer / perc, 200 ezer / nap |

A szűk keret a kivonatolónál a **percenkénti tokenszám**.

## Költség és kapacitás (feltevésekkel, nem mért adat)

A számítás azt feltételezi, hogy egy abstract kivonatolása kb. 450 token (kb. 300 be, 150 ki), és hogy a bemenet és a kimenet együtt számít a keretbe. Ha a modell "gondolkodó" tokeneket is használ, azok szintén fogyasztják a keretet, ezért kevesebb tétel fér bele.

| Mennyiség | Becslés |
|---|---|
| Napi feldolgozható abstract | kb. 400 (200 ezer token / 450) |
| Percenként | kb. 17 |
| Példa: 5 téma × 20 új cikk naponta | kb. 100 tétel, kb. 45 ezer token |
| Egy teljes PDF (több tízezer token) | egy kérésben nem fér a percenkénti keretbe; szakaszolni kell, és így is csak napi néhány cikk |

Ezért a PDF csak kiválasztott cikkhez és kérésre jön szóba ([RESEARCH-PLAN.md](RESEARCH-PLAN.md)).

A költség ingyenes szinten **kvóta**, nem pénz. A szkript ezért:
- **előre becsli** a tokenfogyasztást, és a becslés nélkül nem indul;
- **kemény keretet** tart (napi tokenszám, percenkénti kérésszám), és eléréskor leáll;
- **429-es hibánál** vár és újrapróbál korlátosan, nem ismétel végtelenül;
- minden hívás **tokenfogyasztását naplózza**, így a becslés a valós adatokból pontosítható.

## Védelmi sorrend a külső szövegre

```
külső szöveg (feed, abstract)
   │
   ▼
1. helyi scan + redact           (megvan, hálózat nélkül)
   │  gyanús → elutasít
   ▼
2. Prompt Guard második vélemény (Groq)
   │  gyanús vagy nem elérhető → karantén, nem kerül be (zárt hiba)
   ▼
3. kivonatolás (Groq, GPT OSS)
   │
   ▼
4. a kimenet is átmegy a helyi scan + redact lépésen
   │
   ▼
5. tárolás: névtér, forrás-URL, dátum, címke "nem igazolt"
```

A Prompt Guard **valószínűségi jelzés**, nem védelem. Egy osztályozó téved, ezért csak a helyi `scan` kiegészítője. Ha a szolgáltatás nem elérhető vagy a keret elfogyott, az elem **nem kerül be** (karanténba megy), a mag nem enged át ellenőrizetlen szöveget.

## Kulcsok

Az API-kulcsot a fejlesztő állítja be **környezeti változóként**. Nem kerül a repóba, a naplóba vagy a Colony állapotába, és nem kell elküldeni a modellnek. A szkript a kulcsot soha nem írja ki.

## Megvalósítás (`scripts/groq-summarize.mjs`, `scripts/lib/groq.mjs`)

Külön szkript a magon kívül (a mag nem használ hálózatot). Bemenete egy JSON lista (`{ "id", "source", "text" }`), kimenete egy JSON az elemenkénti eredménnyel.

```
node scripts/groq-summarize.mjs --dir <projekt> --in <elemek.json> --dry-run
node scripts/groq-summarize.mjs --dir <projekt> --in <elemek.json> --yes
```

Elemenként: helyi `scan` (a hostile szöveg el sem megy) → kitakarás → a Groq Prompt Guard modellje (darabolva, zárt hibával) → kivonat → a kivonat helyi `scan` és kitakarás lépése.

- **`--yes` nélkül semmi nem megy ki**, és a `--yes` azt jelenti, hogy te vállalod: minden szöveg nyilvános (feed-elem, abstract, kiadási jegyzet), soha projektfájl. A `--dry-run` a tervet adja (tételek, becsült tokenek, belefér-e a mai keretbe), kulcs és hálózat nélkül.
- **A kulcs** a `GROQ_API_KEY` környezeti változóból jön, csak az `Authorization` fejlécben megy ki, kimenetbe, hibaüzenetbe és fájlba nem kerül. Az API-cím csak a Groq hosztja vagy egy loopback cím lehet (a teszteknél egy hamis szerver); bármi más esetén a szkript nem indul.
- **Keretek:** percenkénti és napi kérés- és tokenszám, a `.colony/provider/groq-usage.json` fájlban számolva. A percenkénti keret rövid várakozással (`--max-wait-sec`) megoldódik, különben az elem `deferred` lesz; a napi keret elfogyása esetén a maradék `deferred`. A 429-es választ korlátozott számú újrapróbálkozással kezeli.
- **Zárt hiba:** a guard hibája, olvashatatlan válasza vagy a küszöböt (`--guard-threshold`, alapérték 0,5, **kalibrálatlan**) elérő pontszám esetén az elem `quarantined`, és kivonat nem készül.
- **Hosszú szöveg:** a szöveg `--max-chars` hosszra csonkul (jelölve), és a guard `--guard-chunk-chars` méretű darabokban nézi (legfeljebb 8 darab). A darabméret **feltevés**, mert a modell bemeneti hosszát nem ellenőriztem.
- **Tesztek:** 10 teszt egy helyi hamis Groq-szerverrel (valódi hívás és valódi kulcs nélkül): kulcs és `--yes` nélkül nincs hívás, a kulcs nem kerül a kimenetbe, a guard hibája zárt, a hostile szöveg és a kitakart cím nem hagyja el a gépet, a keretek és a 429 kezelése, a hosszú szöveg darabolása.
- **Összeomlási hiba, javítva:** Windowson a `process.exit()` hívás a hálózati kapcsolatok bezárása közben összeomlasztotta a Node-ot (ez a tesztben időnként jelentkezett). A szkript a végén `process.exitCode`-ot állít.

**Nem igazolt, az első valódi hívás mutatja meg:** milyen formátumban adja vissza a Prompt Guard az eredményt (a szkript szám vagy JSON pontszámot fogad el, mást zárt hibaként kezel), a `max_completion_tokens` elfogadása a modellnél, hogy a GPT OSS belső gondolatmenete mennyi tokent visz el (üres válasz esetén a szkript a befejezés okát kiírja), és a tényleges tokenfogyasztás.

## Pilot

1. 20–30 abstract kivonatolása a GPT OSS 120B-vel.
2. **Kézi ellenőrzés:** pontosság (tévedés a kivonatban), magyar nyelvi minőség, a kivonat tartalma az eredetihez képest.
3. **Mérés:** a tényleges tokenfogyasztás tételenként, a percenkénti és napi keret kihasználtsága, hogy a modell használ-e "gondolkodó" tokeneket.
4. **Védelem tesztje:** egy kis, szándékosan rosszindulatú mintakészlet (rejtett utasítást tartalmazó szövegek), hogy a Prompt Guard és a helyi `scan` mit fog meg és mit nem.
5. A pilot eredménye dönti el, hogy a kivonatolás megfelel-e, vagy másik modell kell.

## Kockázatok

| Kockázat | Védelem |
|---|---|
| Adatvédelem, a bemenet naplózása vagy felhasználása | csak nyilvános szöveg megy ki; a szolgáltatói feltételeket használat előtt el kell olvasni |
| Egy szolgáltató egy hibapont | cserélhető adapter, zárt hiba, karantén |
| A kisebb modell téved a kivonatban | "nem igazolt" címke, link az eredetihez, kézi mintavétel |
| A modell engedelmeskedik a bemenetbe rejtett utasításnak | védelmi sorrend a kivonatolás előtt, a kimenet is szűrve |
| A keret vagy a modellkínálat változik | a keretek a konfigurációban, nem a kódban; a tokenfogyasztás naplója jelzi az eltérést |
| Kulcs kiszivárgása | környezeti változó, nincs a repóban, nincs a naplóban |

## Nyitott kérdések (nem igazolt)

- A Groq és a modellek licencének és felhasználási feltételeinek tartalma (adatkezelés, ingyenes szint korlátai).
- Hogyan számolja a Groq a tokent (bemenet és kimenet együtt), és mennyi "gondolkodó" token keletkezik.
- A Prompt Guard bemeneti hossza: tudomásom szerint rövid a kontextusa, ezért a szöveget darabolni kell, ez ellenőrizendő.
- A kivonatok magyar nyelvi minősége és tévedési aránya.
- Mennyire áll ellen a GPT OSS 120B a bemenetbe rejtett utasításoknak.
- Fut-e a szkript a Cowork alatt, vagy csak a Claude Code CLI-ben.
