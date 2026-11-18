# Git-párok: holdout készlet a saját történetből

`pairs.json` három valódi, objektív red/green párt rögzít a colony-core történetéből, és elutasított jelölteket.

## Módszer

1. Egy valódi hibajavító commit forrásrészét **visszafordítjuk** (a teszt-fájlok a commitban maradnak): így a hiba visszakerül.
2. A commit tesztjeit a **javított** kódon futtatjuk: mennek át (zöld).
3. Ugyanazokat a teszteket a **visszafordított** kódon: bukniuk kell (piros). Ha nem buknak, a pár nem használható (lásd `2a2a2f4`).

Ez objektív: a tesztek döntenek, nincs modell és nincs szubjektív ítélet.

## Mit mutat és mit nem

- Három pár van, egy elutasítva. A történet kicsi (74 commit), ezért a készlet is kicsi.
- A `4ef136b` piros állapota részben fordítási hiba (a visszafordított forrás nem fordult), nem csak viselkedésbeli. Ezt a `caveat` mező rögzíti.
- A pároknak **holdout**-nak kell lenniük: nem szabad hangolásra használni egy változtatott variánst.

## Futtatható készlet (előre lefordított kiinduló állapot)

A `set.json` három feladat, mindegyik a `fixtures/<id>` mappából indul: ez a visszafordított állapot lefordított `dist/` és `scripts/` mappája (a colony-core futásidőben nem függ külső csomagtól, így a `node_modules` nem kell). A feladat a forrásfájlok (`dist/` .js és `scripts/` .mjs) javítása; a tesztfájlokat nem szabad módosítani.

Az ellenőrzés (`checks/verify-pair.mjs`) két lépés: először összeveti a tesztfájlok hash-ét a `manifest.json`-nal (módosított teszt = elutasítás), majd lefuttatja a commit tesztjeit. Ellenőrzés, hogy mindhárom fixture a visszafordított állapotban bukik, és a javított állapotban (a commit dist és scripts mappájával) átmegy; valamint hogy a módosított teszt-fájlt az ellenőrzés elutasítja.

Egy futtatás költsége és az ügynök-variáns még nincs mérve: a futtatáshoz külön jóváhagyás kell (az eval-run.mjs `--yes` és `--budget-usd`). A készlet **holdout**: nem szabad egy változtatott variáns hangolására használni.

A fixture-ök összesen kb. 7 MB, a repóban vannak, mert a feladatok önmagukban futtathatók kell legyenek.
