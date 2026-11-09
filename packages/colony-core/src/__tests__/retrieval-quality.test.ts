import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VectorCodex } from '../memory/vector-codex.js';
import { DeterministicEmbeddingProvider, PositionalCharEmbeddingProvider, embeddingTokens } from '../memory/embedding-providers.js';
import type { IEmbeddingProvider } from '../memory/types.js';

/**
 * A small retrieval benchmark: past work (documents) and a new task worded differently (query).
 * The right document is the one the query was written about. Mixed Hungarian and English, with
 * inflected forms, because that is how the colony is used. The corpus was written before the v2
 * weights were checked against it and the weights were not tuned on it.
 */
const CASES: Array<{ doc: string; query: string }> = [
  { doc: 'Parse the invoice CSV feed and validate each row', query: 'read invoices from a csv file and check the rows' },
  { doc: 'Számlák beolvasása CSV fájlból és sorok ellenőrzése', query: 'a számla csv beolvasó javítása, sorok validálása' },
  { doc: 'Fix the login redirect loop after the session expires', query: 'users get redirected over and over when their session times out at login' },
  { doc: 'A bejelentkezési munkamenet lejárata után végtelen átirányítás van', query: 'bejelentkezés átirányítási hiba lejárt munkamenetnél' },
  { doc: 'Add pagination to the customer list endpoint', query: 'customers endpoint needs paging, pages of results' },
  { doc: 'Ügyféllista végpont lapozása', query: 'az ügyfelek listázásához oldalazás kell' },
  { doc: 'Speed up the slow database query on the orders table with an index', query: 'orders table query is slow, add a database index' },
  { doc: 'Lassú adatbázis lekérdezés gyorsítása indexszel a rendelések táblán', query: 'rendelés tábla lekérdezései lassúak, index hiányzik' },
  { doc: 'Write unit tests for the payment refund calculation', query: 'tests needed for calculating refunds of payments' },
  { doc: 'Visszatérítés számításának egységtesztjei a fizetési modulban', query: 'fizetés visszatérítés teszt írása' },
  { doc: 'Upgrade the build pipeline to Node 22 and fix the deprecation warnings', query: 'move the ci build to node 22, deprecated api warnings' },
  { doc: 'Node 22-re frissítés a buildfolyamatban, elavult figyelmeztetések javítása', query: 'build pipeline frissítése új node verzióra' },
  { doc: 'Redact personal data from the exported log files', query: 'logs export should hide personal information' },
  { doc: 'Személyes adatok kitakarása a naplófájlokból exportáláskor', query: 'naplók exportálása személyes adat nélkül' },
  { doc: 'Refactor the notification service to retry failed e-mail sends', query: 'notification sending retries when the email fails, refactor service' },
  { doc: 'Az értesítő szolgáltatás átalakítása, hibás e-mail küldés újrapróbálása', query: 'értesítések újrapróbálása sikertelen levélküldés után' },
];

async function evaluate(provider: IEmbeddingProvider): Promise<{ hitAt1: number; mrr: number }> {
  const codex = new VectorCodex({ embeddingProvider: provider });
  await codex.storeDocuments(CASES.map((c, i) => ({ id: `d${i}`, text: c.doc })));
  let hits = 0;
  let rr = 0;
  for (const [i, c] of CASES.entries()) {
    const ranked = await codex.search(c.query, { topK: CASES.length, minScore: -1 });
    const rank = ranked.findIndex((r) => r.document.id === `d${i}`) + 1;
    if (rank === 1) hits++;
    if (rank > 0) rr += 1 / rank;
  }
  return { hitAt1: hits / CASES.length, mrr: rr / CASES.length };
}

test('the v2 embedding finds the right earlier work far more often than the positional baseline', async () => {
  const baseline = await evaluate(new PositionalCharEmbeddingProvider());
  const v2 = await evaluate(new DeterministicEmbeddingProvider());
  console.log(`retrieval benchmark (${CASES.length} queries): baseline hit@1=${baseline.hitAt1.toFixed(2)} mrr=${baseline.mrr.toFixed(2)}; v2 hit@1=${v2.hitAt1.toFixed(2)} mrr=${v2.mrr.toFixed(2)}`);
  assert.ok(v2.hitAt1 >= 0.75, `v2 hit@1 ${v2.hitAt1}`);
  assert.ok(v2.mrr >= 0.85, `v2 mrr ${v2.mrr}`);
  assert.ok(v2.hitAt1 >= baseline.hitAt1 + 0.3, `v2 ${v2.hitAt1} vs baseline ${baseline.hitAt1}`);
});

test('related word forms are close, unrelated texts are not, and the vector is stable', async () => {
  const p = new DeterministicEmbeddingProvider();
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  const [a, b, c] = await p.embedBatch(['feladatok kezelése', 'feladat kezelés', 'rendering shaders on the gpu']);
  assert.ok(dot(a, b) > 0.5, `inflected forms: ${dot(a, b)}`);
  assert.ok(dot(a, c) < 0.2, `unrelated: ${dot(a, c)}`);
  assert.deepEqual(await p.embedText('feladatok kezelése'), a); // deterministic
  assert.ok(Math.abs(Math.sqrt(a.reduce((s, v) => s + v * v, 0)) - 1) < 1e-9); // unit length
});

test('embeddingTokens folds accents and drops stopwords', () => {
  assert.deepEqual(embeddingTokens('Az Ügyfélek listázása, és a lapozás!'), ['ugyfelek', 'listazasa', 'lapozas']);
});

test('the known limit: words with no letters in common are not related', async () => {
  const p = new DeterministicEmbeddingProvider();
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  const [car, automobile] = await p.embedBatch(['fix the car engine', 'repair the automobile motor']);
  assert.ok(dot(car, automobile) < 0.3, 'a synonym with no shared letters is not found: this is lexical similarity, not meaning');
});
