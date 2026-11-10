# Kutatás terv: cikkekből hipotézis, hipotézisből mérés

Állapot: **terv, nincs megvalósítva.** Ami nincs igazolva, azt a "Nyitott kérdések" fejezet sorolja fel.

## Cél

Az AI-témájú szakirodalmat **ötletforrásként** használni: a cikkek kivonatából hipotéziseket rögzíteni, és csak azokat fogadni el, amelyeket az [EVAL-PLAN.md](EVAL-PLAN.md) szerinti mérés alátámaszt. A cikk soha nem bizonyíték.

## Nem cél

- **Nem Google Scholar.** Nincs hivatalos API-ja, a használati feltételei tiltják az automatikus lekérdezést, és a botok ellen CAPTCHA véd. A CAPTCHA kijátszását nem építjük be, és nem is tesszük.
- **Nem általános AI-hírfolyam.** Kézzel kiválasztott témák és kulcsszavak.
- **Nem tanítás.** A cikkben állított eredmény nem kerül tényként a memóriába, és nem a Reasoning Bank-be.
- **Nem része a magnak.** A mag nem használ hálózatot (ezt teszt őrzi). A letöltés külön szkript, mint a radarnál ([RADAR-PLAN.md](RADAR-PLAN.md)).

## Miért hipotézis és nem tudás

Egy cikk állítása nem igazolt: sok eredmény nem reprodukálódik, az előnyomatok (például az arXiv) nem szakértői lektoráltak, és az eredmény egy adott modellre és feladatra érvényes. Ezért a cikk csak egy **hipotézist** adhat, jóslattal és a legolcsóbb próbával, amelyet a meglévő hipotézismező (`debate ... hypothesis`) már megkövetel.

## Folyamat

```
téma + kulcsszavak (a fejlesztő választja)
        │
        ▼
scripts/papers-fetch.mjs   (hálózat itt van, a magon kívül, kézzel indítva)
        │  metaadat + kivonat + link
        ▼
  scan + redact            (a meglévő szűrők)
        │
        ▼
  papers import            (a mag csak fájlt olvas)
        │
        ▼
  névtér `papers`: kivonat + link + dátum, címke: "nem igazolt, ötlet"
        │  a fejlesztő kiválaszt egy cikket
        ▼
  hipotézis: jóslat + legolcsóbb próba   (emberi jóváhagyással)
        │
        ▼
  eval-variáns → mérés → javaslat → a fejlesztő dönt
```

## Források

| Forrás | Mire jó |
|---|---|
| arXiv (API, RSS) | friss előnyomatok, kivonat, nyílt PDF-hivatkozás |
| OpenAlex | metaadat, hivatkozások, nyílt hozzáférés jelzése |
| Semantic Scholar | metaadat, kivonat, hivatkozási adatok |
| Crossref | kiadói metaadat, DOI |

A pontos feltételeket (használati szabályok, kérésgyakorisági korlátok, formátum, kulcs szükséges-e) **megvalósítás előtt le kell ellenőrizni**, ezt még nem tettem meg.

## Elvek

1. **Kivonat és link, nem teljes szöveg.** Jogilag, tárolásilag és költségben is ez a biztonságos. A tárolt szöveg a saját rövid kivonatunk, nem a cikk szövege.
2. **A PDF csak kérésre.** A kiválasztott cikkhez, a fejlesztő indítására, szűrés után. A PDF-ből kinyert szöveg hibás lehet (képletek, táblázatok, kétoszlopos elrendezés), és sok tokent kér.
3. **Minden letöltött szöveg nem megbízható adat.** Egy PDF vagy kivonat rejtett utasítást hordozhat (fehér vagy apró betű, metaadat), ezért `scan` és `redact` fut rajta, a gyanús elem elutasítható.
4. **Külön névtér.** A `papers` és a radar `signals` névtere elkülönül, és a Reasoning Bank-től is.
5. **Minden hipotézis emberi jóváhagyással** kerül az eval-sorba. Semmi nem lesz automatikusan eval-variáns.
6. **Címke mindenhol:** "nem igazolt, ötlet", forrás-URL és letöltési dátum.

## Parancsok (tervezettek)

| Parancs | Mit csinál |
|---|---|
| `papers topics add\|list` | A fejlesztő témái és kulcsszavai. |
| `papers import <fájl>` | A letöltő szkript kimenetét szűri, deduplikálja és tárolja. Hálózatot nem használ. |
| `papers list [--topic T]` | A tárolt kivonatok, a címkével. |
| `papers propose <id> --as <tag>` | Egy kiválasztott cikkből hipotézis-tervezetet készít (jóslat és próba kötelező), jóváhagyásra. |

## Költség

- **Letöltés:** hálózati forgalom, tokent nem fogyaszt.
- **Kivonat-összefoglalás:** kevés token, de a mennyiség a témák számától függ: napi korlát, deduplikálás hash és DOI alapján.
- **PDF feldolgozás:** drága, ezért csak kérésre és kiválasztott cikkhez, előzetes becsléssel.
- **Hipotézis kipróbálása:** a mérés költségét az [EVAL-PLAN.md](EVAL-PLAN.md) költségfejezete adja (kemény keretek, kötelező becslés). Egy cikkből jövő hipotézis kipróbálása a legdrágább lépés, ezért a szűrés (hogy melyik hipotézist érdemes mérni) fontosabb, mint a letöltés.
- A tényleges számokat egy próbafutás méri, ebben a tervben nincs mért adat.

## Kockázatok

| Kockázat | Védelem |
|---|---|
| Nem reprodukálódó vagy téves cikkállítás | a cikk csak hipotézist ad, a döntés mérésen múlik |
| Prompt injection egy PDF-ben | `scan` és `redact`, kivonat-alapú működés, PDF csak kérésre |
| Jogi kérdés (szerzői jog, használati feltételek) | csak kivonat és link, hivatalos API-k, nincs automatikus Scholar-lekérdezés |
| Túl sok hipotézis, kevés mérési keret | emberi jóváhagyás, a mérési keret az eval költségkeretéből jön |
| Divatkövetés, "paper-driven" sodródás | témák kézi kiválasztása; csak mérés után kerül be bármi |
| A mérés egy host-modell párra érvényes | az eredmény jelölése, általánosítás nélkül |

## Mérés

Maga a folyamat is mérhető: a cikkekből érkező hipotézisek hányada igazolódik a mérésen (a `debate stats` hipotézis-számlálójával). Ha a cikkekből jövő hipotézisek igazolódási aránya nem jobb, mint a fejlesztő saját ötleteié, a csatorna nem éri meg a költségét.

## Fázisok

1. **Kézi próba:** egy téma, egy forrás (arXiv), a kivonatok letöltése és a formátum rögzítése.
2. **`papers import`, `list`, `topics`** tesztekkel (mintaadatokkal, hálózat nélkül), a hostile szöveg elutasításával.
3. **`papers propose`:** hipotézis-tervezet, amely a meglévő hipotézismezőbe kerül jóváhagyás után.
4. **Összekötés az eval-lel:** a jóváhagyott hipotézis variánssá válik, és mérés dönt.
5. **Értékelés:** igazolódási arány, költség, és hogy érdemes-e folytatni.

## Nyitott kérdések (nem igazolt)

- Az egyes források használati feltételei, korlátai és formátuma.
- Mennyire megbízható a `scan` egy valós PDF-ből kinyert szövegen (külön tesztkészlet kell).
- Mennyi egy kivonat-összefoglalás és egy hipotézis-tervezet tokenköltsége.
- Hogy a cikkekből jövő hipotézisek valóban javítanak-e a rendszeren: ezt csak a mérés mutatja meg.
- Fut-e a letöltő szkript a Cowork alatt, vagy csak a Claude Code CLI-ben.
