# Szolgáltató terv: Groq a külső szövegek feldolgozására

Állapot: **terv, nincs megvalósítva.** A keretek a fejlesztő által a Groq konzolról bemásolt értékek, **nem ellenőriztem őket**. Ami nincs igazolva, azt a "Nyitott kérdések" fejezet sorolja fel.

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
