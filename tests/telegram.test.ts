// Příkazy z Telegramu — src/telegram.ts. Čisté funkce: bez sítě, bez D1.
// Proč zrovna tohle: příkaz píše člověk do mobilu, tedy s překlepy, s velkým písmenem
// a ve skupině i s @jmenobota. Když parsování selže tiše, vypadá to, že bot nefunguje —
// a formátování je jediné, co uživatel z celé aplikace v Telegramu uvidí.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPositions, formatRun, helpText, isFresh, parseCommand, type PositionRow } from '../src/telegram.ts';

const row = (p: Partial<PositionRow> = {}): PositionRow => ({
  title: 'Vedoucí IT',
  employer: 'VARNET a.s.',
  real_employer: null,
  location: 'Brno',
  relevance: 85,
  source: 'jobs.cz',
  url: 'https://www.jobs.cz/rpd/2001272748/',
  ...p,
});

test('/pozice bez čísla vezme práh z Nastavení', () => {
  assert.deepEqual(parseCommand('/pozice'), { kind: 'positions', minScore: null });
});

test('/pozice 60 vezme práh ze zprávy', () => {
  assert.deepEqual(parseCommand('/pozice 60'), { kind: 'positions', minScore: 60 });
});

test('ve skupině chodí /pozice@JobWatchBot — jméno bota se musí odříznout', () => {
  assert.deepEqual(parseCommand('/pozice@JobWatchBot 60'), { kind: 'positions', minScore: 60 });
});

test('velké písmeno ani mezery navíc příkaz nerozbijí — píše se to do mobilu', () => {
  assert.deepEqual(parseCommand('  /POZICE   40 '), { kind: 'positions', minScore: 40 });
});

test('překlep v čísle spadne na práh z Nastavení, ne na chybu', () => {
  assert.deepEqual(parseCommand('/pozice sedmdesát'), { kind: 'positions', minScore: null });
});

test('skóre se zastropuje na 0–100 — jinak by dotaz vrátil prázdno', () => {
  assert.deepEqual(parseCommand('/pozice 900'), { kind: 'positions', minScore: 100 });
  assert.deepEqual(parseCommand('/pozice -5'), { kind: 'positions', minScore: 0 });
});

test('běžná věta není příkaz — na chat se nesmí odpovídat na všechno', () => {
  assert.equal(parseCommand('ahoj, co je nového?'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand(undefined), null);
});

test('/help i /start dají nápovědu — /start pošle Telegram sám při prvním otevření', () => {
  assert.deepEqual(parseCommand('/help'), { kind: 'help' });
  assert.deepEqual(parseCommand('/start'), { kind: 'help' });
});

test('neznámý příkaz se pozná, aby šlo odpovědět nápovědou místo ticha', () => {
  assert.deepEqual(parseCommand('/neexistuje'), { kind: 'unknown', text: 'neexistuje' });
});

test('výpis nese skóre, pozici, zaměstnavatele, lokalitu i odkaz', () => {
  const t = formatPositions([row()], 70, 1);
  assert.match(t, /85 · Vedoucí IT/);
  assert.match(t, /VARNET a\.s\. · Brno/);
  assert.match(t, /jobs\.cz\/rpd\/2001272748/);
});

test('u agentury se ukáže i odmaskovaný původce — jinak je lead k ničemu', () => {
  const t = formatPositions([row({ employer: 'Grafton', real_employer: 'Skupina ČEZ' })], 70, 1);
  assert.match(t, /Grafton → Skupina ČEZ/);
});

test('useknutý výpis to musí přiznat — jinak se čte jako „tohle je všechno"', () => {
  const t = formatPositions([row(), row(), row()], 70, 40);
  assert.match(t, /a další 37/);
});

test('když se vejde všechno, o dalších se nic nepíše', () => {
  assert.doesNotMatch(formatPositions([row()], 70, 1), /a další/);
});

test('prázdný výsledek poradí nižší práh místo holého „nic"', () => {
  const t = formatPositions([], 70, 0);
  assert.match(t, /Žádná pozice/);
  assert.match(t, /\/pozice 50/);
});

test('nápověda ukazuje skutečný práh z Nastavení, ne vymyšlený', () => {
  assert.match(helpText(70), /skóre ≥ 70/);
});

test('čerstvá zpráva se vyřídí, půl dne stará ne — odpověď na včerejší dotaz je k ničemu', () => {
  const now = 1_800_000_000;
  assert.equal(isFresh(now - 30, now), true);
  assert.equal(isFresh(now - 43_200, now), false);
});

test('zpráva na hranici 10 minut ještě projde — cron chodí po pěti', () => {
  const now = 1_800_000_000;
  assert.equal(isFresh(now - 600, now), true);
  assert.equal(isFresh(now - 601, now), false);
});

test('chybějící datum se bere jako čerstvé — radši odpovědět navíc než mlčet', () => {
  assert.equal(isFresh(undefined, 1_800_000_000), true);
});

test('/beh, /run i /spustit spustí běh — a /start ne, ten posílá Telegram sám', () => {
  assert.deepEqual(parseCommand('/beh'), { kind: 'run' });
  assert.deepEqual(parseCommand('/run'), { kind: 'run' });
  assert.deepEqual(parseCommand('/spustit'), { kind: 'run' });
  // Telegram pošle /start při prvním otevření chatu. Kdyby to spouštělo běh, agent by
  // se rozjel jen tím, že si někdo otevře konverzaci.
  assert.deepEqual(parseCommand('/start'), { kind: 'help' });
});

test('/stav i /status se ptají na poslední běh', () => {
  assert.deepEqual(parseCommand('/stav'), { kind: 'status' });
  assert.deepEqual(parseCommand('/status@JobWatchBot'), { kind: 'status' });
});

test('nedoběhlý běh se nehlásí jako úspěch ani jako pád — je to „běží"', () => {
  const t = formatRun({ started_at: '2026-08-31 14:00', finished_at: null, trigger: 'manual', ok: 0, stats: null });
  assert.match(t, /ještě běží/);
  assert.doesNotMatch(t, /❌|✅/);
});

test('doběhlý běh nese značku výsledku i čísla ze statistiky', () => {
  const t = formatRun({
    started_at: '2026-08-31 14:00',
    finished_at: '2026-08-31 14:03',
    trigger: 'cron',
    ok: 1,
    stats: '{"fetched":101,"candidates":65,"scored":15,"notified":0,"queueDepth":147,"prefiltered":9}',
  });
  assert.match(t, /^✅/);
  assert.match(t, /staženo 101/);
  assert.match(t, /vyřazeno filtrem bez AI 9/);
});

test('rozbitá statistika nesmí shodit odpověď — hlavička stačí', () => {
  const t = formatRun({ started_at: 'a', finished_at: 'b', trigger: 'cron', ok: 0, stats: '{tohle není JSON' });
  assert.match(t, /^❌/);
});

test('žádný běh v historii se řekne rovnou, ne prázdnou zprávou', () => {
  assert.match(formatRun(null), /Zatím neproběhl/);
});
