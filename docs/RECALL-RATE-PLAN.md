# Terv: a felidézések értékelése (`recall`)

Állapot: **terv, nincs megvalósítva.** Ez az 1. fázis előfeltétele ([DIRECTION.md](DIRECTION.md), [ROADMAP.md](../ROADMAP.md)): ezen mérjük meg, hogy a felidézés ér-e valamit.

## Miért kell

A hook minden promptnál felidézést ad (a korábbi munkából), és azt `recall.jsonl`-be írja. Ma **nincs mód arra, hogy a fejlesztő megmondja, hasznos volt-e**. A `rate` csak befejezett feladatokat értékel, a felidézés nem feladat. Hasznosság nélkül az 1. fázis kilépése (30 értékelt munkamenet, 50% felett) nem mérhető.

## Mi van már most

- **Hook (`src/hook/events.ts`):** a prompt-felidézés minden olyan esetben logol egy sort (`at`, `session`, `ids`), ha volt találat. Az `ids` a Reasoning Bank mintaazonosítói (`pattern_task_<feladatazonosító>`).
- **`rate` (`src/cli/rate.ts`):** feladat minőségét állítja be a fejlesztő állítása szerint. Felidézésre nincs parancs.
- **Session-indítási felidézés:** a `session` hook a munkamenet elején ad felidézést. Ez **nincs naplózva** (a `recall.jsonl` csak a prompt-hook sorait tartalmazza). Ezt a tervben pótoljuk, mert az 1. fázis mindkettőt mér.

## Javasolt parancsok

| Parancs | Mit csinál |
|---|---|
| `recall list [--k N] [--unrated]` | A felidézési események sorszámmal, időponttal, munkamenettel, a felidézett minták címével (a kivonat a fejlesztőnek mutatott szöveg, nem új adat). |
| `recall rate <sorszám> --useful yes\|partly\|no [--note TEXT]` | A fejlesztő értékelése egy eseményhez. A `--note` ugyanúgy szűrt (`scan`, `redact`), mint a többi szöveg. |
| `recall stats` | Értékelt események száma, munkamenetek száma, a hasznos (`yes` = 1, `partly` = 0,5, `no` = 0) arány, és a két kilépési feltétel: 30 értékelt munkamenet, 50% felett. |

## Adatmodell

- Új fájl: `.colony/recall/ratings.jsonl`. Egy sor egy értékelés: `{ event, session, at, useful, note, ratedAt }`. A `event` a `recall.jsonl` sorának azonosítója (időbélyeg és munkamenet), így az értékelés a felidézéshez kötődik, és nem írjuk át a naplót.
- Az értékelés a **fejlesztő állítása** (mint a `quality` és a `verified-by-test`): a rendszer nem tudja ellenőrizni, csak rögzíti, és a jelentés ezt kimondja.
- Az audit-napló minden értékelésről bejegyzést kap (`recall.rated`), a lánc így ellenőrizhető.

## Elvek

1. **A felidézés nem változik a méréstől.** Az értékelés csak rögzít. Nem finomítjuk a keresést és nem írjuk át a mintákat a visszajelzés alapján (ez a 2. fázis, a mérés után).
2. **Egy esemény, egy értékelés.** Újraértékelés új sorként kerül, a `recall stats` az utolsót veszi. Nem lehet elveszteni egy régi értékelést.
3. **Nincs automatikus értékelés.** A host nem értékelhet a fejlesztő helyett. A kérdés a hookban csak emlékeztet, hogy értékelni lehet.
4. **Az értékelés nem befolyásolja a munkát.** Nincs kapu, nincs blokkolás.

## Kilépési feltétel és a mérés

- **Kilépés:** legalább **30 értékelt munkamenet** (különböző munkamenetek), és a hasznosság a `recall stats`-ban látszik.
- **Döntési szabály előre rögzítve:** 50% alatt a felidézést nem bővítjük, hanem megvizsgáljuk az okát (a `note` mezőkből és a `recall list`-ből). 50% felett marad a jelenlegi irány.
- **Torzítás, amit ki kell mondani:** a fejlesztő szubjektíven értékel, és tudja, hogy méri. A `partly` és a `no` közötti határ önkényes. A mérés a munka hasznára vonatkozik, nem objektív pontosságra.

## Tesztek (tervezett)

- Egy felidézési esemény értékelése, újraértékelés, és az utolsó érvényes.
- Ismeretlen sorszám, hibás `--useful` érték, túl hosszú vagy hostile `--note` elutasítása (és naplózása).
- A `recall stats` számítása: súlyozás, kilépési feltételek, munkamenetek száma.
- A session-indítási felidézés naplózása (új eset a hookban).
- A `recall.jsonl` és a `ratings.jsonl` sérült sora nem akasztja meg a többit.

## Mit nem csinálunk most

- A keresés és a rangsor javítása (2. fázis).
- Automatikus hasznosság-becslés (a fejlesztő ítélete a mérés).
- Több fejlesztő, megosztás (4. fázis).

## Becsült munka

Egy kisebb ág: új parancs-modul, egy fájl a tároláshoz, a session-hook naplózása, és tesztek. A méréshez utána a fejlesztő saját munkája kell (30 munkamenet), ez nem kódmunka.
