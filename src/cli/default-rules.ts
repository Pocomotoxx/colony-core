/** Starter rule set, written to `.colony/rules/` on the first boot. After that the files belong to the project. */
export const DEFAULT_RULES: Record<string, string> = {
  '00-protocol.md': `# Munkaprotokoll

- A host a modell. A Colony csak főkönyv, útvonalválasztás, szavazás és memória.
- Munkát csak a \`next\` parancson át veszel fel, és csak a neked kiosztott feladaton dolgozol.
- A munka végén \`done\` (eredménnyel) vagy \`fail\` (hibaszöveggel) kötelező. Félbehagyott feladatot ne hagyj \`in_progress\` állapotban.
- Boot nélkül nincs munka. Ha a boot után a szabályfájlok vagy a git-revízió változtak, bootolj újra.
- Az \`UNVERIFIABLE\` boot azt jelenti, hogy a git-revízió ismeretlen: tartalmi munka mehet, a repó módosítása nem.
`,
  '10-evidence.md': `# Bizonyíték és őszinte jelentés

- Eredményt, szavazati indoklást és memóriabejegyzést soha ne találj ki. Csak azt írd le, amit ténylegesen megtettél vagy ellenőriztél.
- A \`done\` eredménye mondja meg, mi készült el és hogyan ellenőrizted. Ha valamit nem ellenőriztél, írd bele.
- A boot azt bizonyítja, hogy az állapot és a szabályfájlok be lettek olvasva. Azt nem, hogy alkalmaztad őket. Ne állítsd, hogy betartottad, ha nem tudod megmutatni.
- Sikertelen vagy részleges munkát \`fail\` paranccsal jelents, ne \`done\`-nal.
`,
  '20-consensus.md': `# Konszenzus

- Konszenzusos feladatot csak jóváhagyott javaslat után zárhatsz le.
- Szavazni csak konkrét indoklással lehet, amely arra hivatkozik, amit ellenőriztél.
- A kvórumot nem töltheted ki egyedül más tagok nevében úgy, hogy az ő szempontjukat nem vizsgáltad meg.
- Elutasított vagy lejárt javaslat után a feladat nem zárható \`done\`-nal: dolgozd át és javasolj újra, vagy jelentsd \`fail\`-lel.
`,
};

export const DEFAULT_MANIFEST = {
  version: 1,
  mandatory: Object.keys(DEFAULT_RULES),
};
