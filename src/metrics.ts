// Měřák rozpočtu běhu.
//
// Proč: Worker má strop na počet podřízených požadavků na jedno vyvolání (na free plánu 50)
// a **volání D1 se do něj počítají**, ne jen HTTP. Ten strop je skutečné omezení propustnosti
// — ne `MAX_SCORES_PER_RUN`, jak se dlouho myslelo. Dokud se odhadoval ze statické analýzy
// kódu, bylo to jen počítání na papíře. Tohle si ho spočítá samo za běhu a zapíše do
// `runs.stats`, takže po každé změně je vidět, jestli pomohla nebo uškodila.
//
// Neměří se stahování zdrojů (fetch uvnitř `src/sources/*`) — globální `fetch` se obalit
// nedá bezpečně, protože izolát sdílí víc souběžných vyvolání. To, co chybí, se v logu
// přizná, aby se součet nečetl jako úplný.

/** Co se počítá. Jedna položka = jeden podřízený požadavek. */
export interface RunBudget {
  /** Volání D1 (dotazy i dávky; dávka = 1, o to jde). */
  d1: number;
  /** Volání jazykového modelu. */
  model: number;
  /** HTTP kontroly živosti inzerátu. */
  liveness: number;
}

export interface Counter {
  add(kind: keyof RunBudget, n?: number): void;
  snapshot(): RunBudget & { celkem: number };
}

export function createCounter(): Counter {
  const b: RunBudget = { d1: 0, model: 0, liveness: 0 };
  return {
    add(kind, n = 1) {
      b[kind] += n;
    },
    snapshot() {
      return { ...b, celkem: b.d1 + b.model + b.liveness };
    },
  };
}

/** Skutečný D1 statement schovaný pod obalem — `batch()` potřebuje originál, ne obal. */
const REAL = Symbol('real');

function wrapStmt(st: any, m: Counter): any {
  return {
    [REAL]: st,
    bind: (...a: unknown[]) => wrapStmt(st.bind(...a), m),
    first: (...a: unknown[]) => {
      m.add('d1');
      return st.first(...a);
    },
    run: (...a: unknown[]) => {
      m.add('d1');
      return st.run(...a);
    },
    all: (...a: unknown[]) => {
      m.add('d1');
      return st.all(...a);
    },
    raw: (...a: unknown[]) => {
      m.add('d1');
      return st.raw(...a);
    },
  };
}

/**
 * Obalí D1 tak, aby se počítalo každé volání — bez zásahu do volajících míst.
 *
 * `batch()` se počítá jako **jedna** položka, protože jeden round-trip taky jeden je;
 * v tom je celý smysl dávkování. Statementy se před předáním rozbalí na originály,
 * jinak by je D1 nepřijala.
 */
export function wrapDb(db: any, m: Counter): any {
  return {
    prepare: (sql: string) => wrapStmt(db.prepare(sql), m),
    batch: (stmts: any[]) => {
      m.add('d1');
      return db.batch(stmts.map((s) => s?.[REAL] ?? s));
    },
    exec: (sql: string) => {
      m.add('d1');
      return db.exec(sql);
    },
    dump: db.dump?.bind(db),
    withSession: db.withSession?.bind(db),
  };
}

/**
 * Řádek do logu běhu. Přiznává i to, co se nezměřilo — součet bez té poznámky by se
 * četl jako úplný a člověk by podle něj usoudil, že do stropu je dál, než je.
 */
export function formatBudget(
  b: RunBudget & { celkem: number },
  scored: number,
  zpracovano = scored,
): string {
  // Dvě různá čísla, protože měří dvě různé věci. Běh 133 (1. 9. 2026) utratil 127 požadavků,
  // ohodnotil 9 inzerátů a dalších 105 vyřadil kód. „127 ÷ 9 = 14,1 na inzerát" z toho dělá
  // drahé skórování, přestože skoro všechnu práci odvedlo levné vyřazení: na zpracovanou
  // položku vyšlo 1,1. Jedno číslo tady lže vždycky — proto obě.
  const naOhodnocený = scored > 0 ? (b.celkem / scored).toFixed(2) : '—';
  const naZpracovaný = zpracovano > 0 ? (b.celkem / zpracovano).toFixed(2) : '—';
  return (
    `📶 Rozpočet požadavků: D1 ${b.d1} · model ${b.model} · živost ${b.liveness} = ${b.celkem} ` +
    `(+ stahování zdrojů, to se neměří) · na zpracovanou položku ${naZpracovaný} · ` +
    `na ohodnocený modelem ${naOhodnocený}`
  );
}
