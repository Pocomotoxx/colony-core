# PBv holdout minta (SWE-PolyBench_Verified, TS/JS)

`sample-30.json`: 30 feladat azonosítói a SWE-PolyBench_Verified adatkészletből (csak metaadat: instance_id, repo, language, base_commit). A feladatok tartalmát (patch, teszt, leírás) nem tartalmazza, azt a letöltött adatfájlból kell kiolvasni.

Kiválasztás: a tiszta készlet (csak MIT-es forrásrepók, a serverless/serverless kizárva a nem-MIT licenc miatt), 167 feladat; nyelvenként arányosan 18 TypeScript és 12 JavaScript, determinisztikus keverés (seed 20261118, instance_id szerint rendezve). A repók: mui/material-ui 13, sveltejs/svelte 8, microsoft/vscode 4, prettier/prettier 4, coder/code-server 1. A tailwindcss, az angular és a three.js nem került a mintába.

Holdout: nem szabad egy változtatott variáns hangolására használni. Licenc: a dataset kártya MIT; a feladatok nyílt forrású projektekből származnak, a forrás-licencek a repókra vonatkoznak (mind MIT, a serverless kivételével).

Állapot: a futtatás még nincs megoldva (feladatonként környezet kell, a mui és a vscode nagy függőségekkel dolgozik). Először egy környezet-próba szükséges.
