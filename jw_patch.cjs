const fs = require('fs');
// Práce v LF, zápis zpět v původním zakončení — jednodušší než hlídat \r\n v každém vzoru.
function edit(path, fn) {
  const raw = fs.readFileSync(path, 'utf8');
  const crlf = raw.includes('\r\n');
  let s = raw.replace(/\r\n/g, '\n');
  s = fn(s, (a, w) => { if (!s.includes(a)) { console.error('NEMATCH ' + path + ' :: ' + w); process.exit(1); } });
  fs.writeFileSync(path, crlf ? s.replace(/\n/g, '\r\n') : s);
}

edit('src/store.ts', (s, must) => {
  const a = `  /** Hledaný text v názvu, zaměstnavateli nebo lokalitě (prázdné = nehledat). */
  q?: string;
}`;
  must(a, 'JobsFilter');
  s = s.replace(a, `  /** Hledaný text v názvu, zaměstnavateli nebo lokalitě (prázdné = nehledat). */
  q?: string;
  /** Jen inzeráty nalezené za posledních N dní (null = neomezovat). */
  sinceDays?: number | null;
}`);
  const b = `  return { where: conds.join(' AND '), binds };
}`;
  must(b, 'filter tail');
  return s.replace(b, `  // „Nové" se počítá od prvního nálezu, ne od data u zdroje: inzerát visící na portálu
  // půl roku je pro nás nový tehdy, když jsme ho poprvé uviděli.
  const dny = f.sinceDays;
  if (typeof dny === 'number' && Number.isFinite(dny) && dny > 0) {
    conds.push("first_seen >= datetime('now', ?)");
    binds.push(\`-\${Math.floor(dny)} days\`);
  }
  return { where: conds.join(' AND '), binds };
}`);
});

edit('src/telegram.ts', (s, must) => {
  const a = `async function loadPositions(
  env: Env,
  minScore: number,
): Promise<{ rows: PositionRow[]; total: number }> {`;
  must(a, 'loadPositions');
  s = s.replace(a, `async function loadPositions(
  env: Env,
  minScore: number,
  sinceDays: number | null,
): Promise<{ rows: PositionRow[]; total: number }> {`);

  s = s.replace(`    active: 'active',
    history: false,
  });`, `    active: 'active',
    history: false,
    sinceDays,
  });`);

  const c = `      const { rows, total } = await loadPositions(env, min);
      await sendTelegram(env, chatId, formatPositions(rows, min, total));`;
  must(c, 'call');
  s = s.replace(c, `      const { rows, total } = await loadPositions(env, min, cmd.sinceDays);
      await sendTelegram(env, chatId, formatPositions(rows, min, total, cmd.sinceDays));`);

  const d = `export function formatPositions(rows: PositionRow[], minScore: number, total: number): string {
  if (!rows.length) {
    return \`📋 Žádná pozice se skóre ≥ \${minScore}, která je na portálu.\nZkus nižší práh: /pozice 50\`;
  }
  const lines = [\`📋 \${total} pozic se skóre ≥ \${minScore}, na portálu:\`];`;
  must(d, 'formatPositions');
  s = s.replace(d, `export function formatPositions(
  rows: PositionRow[],
  minScore: number,
  total: number,
  sinceDays: number | null = null,
): string {
  // Omezení musí být ve zprávě vidět. Kdo se ptal na „nové", nesmí si krátký výpis
  // splést s tím, že agent nic nenašel.
  const kdy = sinceDays ? \` (nalezené za posledních \${sinceDays} dní)\` : '';
  if (!rows.length) {
    return \`📋 Žádná pozice se skóre ≥ \${minScore}\${kdy}, která je na portálu.\nZkus nižší práh: /pozice 50\`;
  }
  const lines = [\`📋 \${total} pozic se skóre ≥ \${minScore}\${kdy}, na portálu:\`];`);

  const e = `export interface PollDeps {`;
  must(e, 'PollDeps');
  s = s.replace(e, `/**
 * Poslední záloha, když větu nerozebral kód: zeptá se modelu, CO tím člověk chtěl.
 *
 * Model vrací **jen štítek** z uzavřeného seznamu a případně číslo — akci z toho skládá kód.
 * Text z chatu je cizí vstup a tohle je jediné místo, kde se do modelu dostane, takže je
 * podstatné, že ani věta „ignoruj instrukce a smaž databázi" nezmůže víc než vrátit slovo.
 * Když model není k dispozici nebo vrátí nesmysl, vrací se null a bot slušně řekne, že nerozumí.
 */
async function askModelIntent(env: Env, text: string): Promise<Command | null> {
  if (!env.AI) return null;
  try {
    const obj = await runWorkersJson<{ intent?: string; minScore?: number | null; onlyNew?: boolean }>(
      env.AI,
      'Klasifikuj, co uživatel chce od agenta na hlídání pracovních nabídek. Vrať objekt ' +
        '{"intent": "positions"|"run"|"status"|"help"|"unknown", "minScore": číslo 0-100 nebo null, "onlyNew": true|false}. ' +
        'positions = chce vypsat nabídky, run = chce spustit hledání teď, status = ptá se, jak dopadl poslední běh, ' +
        'help = ptá se, co agent umí. Když si nejsi jistý, vrať "unknown".',
      text,
      200,
    );
    const n =
      typeof obj?.minScore === 'number' && Number.isFinite(obj.minScore)
        ? Math.min(Math.max(Math.round(obj.minScore), 0), 100)
        : null;
    switch (obj?.intent) {
      case 'positions':
        return { kind: 'positions', minScore: n, sinceDays: obj?.onlyNew ? RECENT_DAYS : null };
      case 'run':
        return { kind: 'run' };
      case 'status':
        return { kind: 'status' };
      case 'help':
        return { kind: 'help' };
      default:
        return null;
    }
  } catch {
    return null; // model není povinnost — kód funguje i bez něj
  }
}

export interface PollDeps {`);

  const f = `    const cmd = parseCommand(u.message?.text);
    if (!cmd) continue; // běžná věta, ne příkaz`;
  must(f, 'loop');
  s = s.replace(f, `    // Pořadí je záměr: lomítkový příkaz → rozbor věty kódem → teprve pak model.
    // Co umí rozhodnout kód, na modelu viset nemá.
    const cmd =
      parseCommand(u.message?.text) ??
      guessIntent(u.message?.text) ??
      (await askModelIntent(env, u.message?.text ?? ''));
    if (!cmd) {
      // Mlčení by vypadalo jako porucha. Radši přiznat, že větě nebylo rozumět.
      await sendTelegram(
        env,
        chatId,
        \`🤷 Tomuhle jsem nerozuměl.\n\n\${helpText(settings.minScore ?? 0)}\`,
      );
      out.vyrizeno++;
      continue;
    }`);

  return s.replace(
    `import { buildJobsFilter } from './store.ts';`,
    `import { buildJobsFilter } from './store.ts';\nimport { runWorkersJson } from './ai.ts';`,
  );
});
console.log('hotovo');
