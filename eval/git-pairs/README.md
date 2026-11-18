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

## Miért nem futtatható még eval-készletként

Az eval-futás munkamappájában a TypeScript-projektnek fordulnia kell és a függőségeknek ott kell lenniük. Ez futásonként teljes másolást vagy megosztott `node_modules`-t kér, és ezt a biztonsági szabályok szerint külön kell jóváhagyni. Két lehetőség:

1. **Előre lefordított változat**: a munkamappa tartalmaz egy futtatható (JS) kiinduló állapotot, az ügynök JS-fájlokat szerkeszt. Egyszerűbb, de a forrás a TypeScript-től eltér.
2. **Megosztott függőségek**: a munkamappa csak a forrást kapja, a `node_modules` egy közös, csak olvasható helyen van. A szerkesztés és a fordítás a munkamappában történik.

A döntés a futtató tervéhez tartozik, külön jóváhagyást kér.

## Következő lépés

A holdout készlet fut, ha a fenti két lehetőség közül eldőlt a fordítás helye. Addig a `pairs.json` a nyilvántartás.
