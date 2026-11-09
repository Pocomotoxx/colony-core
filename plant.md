# Átalakítási terv: Colony

> **Frissítés (2026-10-31):** a terv eredeti LLM-es elemei kivezetve. A 3. alapelv (provider-agnosztikus LLM-interfészek), a 4.3 (`ColonyWorker`) és a teljes VII. fázis (`providers.ts`, `github-runner.ts`, GitHub Actions workflow) már nincs a kódban. A host (Cowork) maga a modell, a mag csak főkönyv, szavazás és helyi memória.

## 1. Áttekintés és Célok

A projekt célja a régi, rajalapú architektúra teljes átültetése egy **tiszta, modern TypeScript / ESM / Bun** alapú keretrendszerbe, megszüntetve a közvetlen Claude-függőségeket, miközben a működési logikát, metódusokat és robusztusságot hiánytalanul megőrizzük.

### Alapelvek:
1. **Név- és fogalomkonverzió**: A korábbi "Swarm" (raj) architektúra helyett egységesen a **"Colony" (Colony)** fogalmat és terminológiát alkalmazzuk (pl. ColonyHub, ColonyCoordinator, ColonyMember/Worker, QueenCoordinator helyett ColonyDirector/Controller).
2. **Platform & Runtime**: Modern ESM, Bun / Node modern runtime kompatibilitás, TypeScript strict mode, zéró felesleges Claude-specifikus lock-in.
3. **Modell-függetlenség (LLM & Embeddings)**: Provider-agnosztikus interfészek (OpenAI, Gemini/Google AI, Anthropic, Ollama, Helyi modellek / ONNX / transformers).
4. **Független és moduláris rétegek**: Clean Architecture / Domain Driven Design (DDD) minta követése: Domain -> Application -> Infrastructure -> Interfaces.

---

## 2. Architektúra & Fő Modulok

```
colony-core/ (vagy packages/)
├── colony/                # Korábbi Swarm - Colony raj- és ágenskoordináció
│   ├── coordination/      # Feladat delegálás, Agent registry, ColonyHub
│   ├── consensus/         # Byzantine fault tolerance, Raft, Gossip protokollok
│   ├── attention/         # Attention / prioritás koordinátor
│   └── domain/            # Task, Member, Colony entitások és repository interfészek
│
├── memory/                # Modell-független Vektor és Tudástár (Vector Codex)
│   ├── vector/            # HNSW index, cosine similarity, kNN keresés
│   ├── stores/            # SQLite / LibSQL / In-Memory / Vector store adapterek
│   ├── retrieval/         # Hibrid keresés (FTS5 full-text + Vector MMR reranking)
│   ├── embeddings/        # Provider-agnosztikus embedding adapter (OpenAI, Gemini, Local)
│   └── tiered/            # Többszintű memóriakezelés (rövid távú kontextus, hosszú távú tudás)
│
├── agents/                # Ágens definíciók és szerepkörök (60+ ágens profil)
│   ├── runtime/           # Ágens életciklus-kezelő (spawn, execute, terminate)
│   ├── profiles/          # Fejlesztő, tesztelő, elemző, biztonsági profilok
│   └── tools/             # Eszközkészlet és MCP (Model Context Protocol) csatolók
│
└── runner/                # Belépési pontok, CLI és Bun runtime konfiguráció
```

---

## 3. Részletes Megvalósítási Lépések

### I. Fázis: Projekt Környezet & Alapok Inicializálása (Bun / ESM)
- [x] **1.1 Csomag és projektstruktúra**:
  - `packages/colony-core/package.json` kialakítása: Bun és Node ESM támogatás, TypeScript `tsconfig.json` optimalizálás.
  - Alapvető utility-k és függőségek beállítása (zod, @types/node, typescript).
- [x] **1.2 Közös típusok és interfészek (`types.ts`)**:
  - Feladatállapotok, ágens-állapotok, eseménybusz (`MessageBus`) és szavazási típusdefiníciók.

### II. Fázis: Colony (Orchestrator) Modul Újraépítése
- [x] **2.1 Belső Esemény- és Kommunikációs Busz (`MessageBus`)**:
  - Helyi és elosztott aszinkron eseménycsere a Colony tagjai között topic és wildcard támogatással.
- [x] **2.2 Ágens Nyilvántartó és Életciklus (`ColonyRegistry`)**:
  - Ágensek regisztrációja, kapacitáskezelés, állapotkövetés (`idle`, `busy`, `offline`), alkalmas ágens kereső.
- [x] **2.3 Colony Feladat-Orchestrátor (`ColonyTaskOrchestrator`)**:
  - Feladatok dekomponálása, függőségi lánc (`dependencies`) kezelése, automatikus delegálás.
- [x] **2.4 Konszenzus és Döntéshozatal (`ConsensusEngine`)**:
  - Kvórum- és megbízhatósági súlyozású szavazási mechanizmusok tiszta TypeScriptben.
- [x] **2.5 Colony Vezérlő (`ColonyHub`)**:
  - Központi API a feladatok indítására, felügyeletére és snapshot lekérdezésére.

### III. Fázis: Modell-Független Memória & Vektor Codex Rendszer
- [x] **3.1 Provider-Agnosztikus Embedding Interfész (`IEmbeddingProvider`)**:
  - Egységes illesztő: OpenAI / Gemini / helyi determinisztikus beágyazások.
- [x] **3.2 Vektor Index & Tárhely (`InMemoryVectorStore`)**:
  - Nagy sebességű koszinusz-hasonlóság alapú vektor-összehasonlítás, névtér izoláció.
- [x] **3.3 Vektor Codex Tudástár (`VectorCodex`)**:
  - Dokumentumok beágyazása és szemantikus visszakeresése közvetlenül a feladat-végrehajtáshoz.

### IV. Fázis: Ágens Szerepkörök és Képességek Átemelése
- [x] **4.1 Ágens profilok és szerepkörök (`BUILTIN_AGENT_PROFILES`)**:
  - Director, Architect, Coder, Reviewer, Tester, Security profilok tiszta specifikációval.
- [x] **4.2 Zod-alapú Eszköztár (`ColonyToolRegistry`)**:
  - Típusbiztos szerszámhívás és validáció a feladatok futtatásához.
- [x] **4.3 Ágens Végrehajtó Motor (`ColonyWorker`)**:
  - Automatikus Vector Codex kontextus-lekérdezés, eszközhasználat és feladat-lezárás.

### VII. Fázis: GitHub-Bázisú Futtatási Környezet & Valós LLM Hívások
- [x] **7.1 Lemez- és Git-alapú Vektor Memória Perzisztencia (`FileVectorStore`)**:
  - A Colony memóriáját, vektoros beágyazásait és a Reasoning Bank tapasztalatait a repó `.colony/memory.json` fájljába menti és onnan olvassa vissza automatikusan.
- [x] **7.2 Modell- és API-szolgáltatók (`providers.ts`)**:
  - **Google Gemini API** natív REST adapter (`GEMINI_API_KEY`).
  - **OpenAI / OpenRouter / Ollama** kompatibilis adapter (`OPENAI_API_KEY`, `OPENAI_BASE_URL`).
  - Offline/determinisztikus fallback API-kulcs hiánya esetén.
- [x] **7.3 GitHub Runner és Belépési Pont (`github-runner.ts`)**:
  - A GitHub Actions környezetben közvetlenül futtatható belépési pont (`dist/github-runner.js`), amely környezeti változókból (`COLONY_TASK_TITLE`, `COLONY_TASK_DESC`) vagy parancssori argumentumokból veszi a feladatot.
  - Az eredményeket a `.colony/outputs/` mappába generálja JSON és formázott formátumban.
- [x] **7.4 GitHub Actions Workflow (`colony-runner.yml`)**:
  - Automatikus rajt: manuális dispatch, Issue felcímkézése (`colony`), vagy Issue-komment (`/colony ...`).
  - Automatikus memória-visszatöltés, LLM modellhívás a Colonyn keresztül, majd a megújult tudástár (`.colony/`) automatikus visszakommitolása a GitHub repóba.

---

## 4. Következő Lépés
A terv jóváhagyása után a **`Colony` modul tiszta ESM/TypeScript architektúrájának és a közös típusoknak a létrehozásával** kezdünk.
