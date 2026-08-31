// Brána na verzi promptu — scripts/prompt-check.ts. Čistá funkce nad textem diffu.
// Proč zrovna tohle: bez ní se dá prompt tiše přepsat a v uložených bězích pak leží dvě
// různá znění pod jedním číslem — změna chování se nedá spárovat s příčinou.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsVersionBump } from '../scripts/prompt-check.ts';

test('prompt se nezměnil → verzi zvyšovat netřeba', () => {
  assert.equal(needsVersionBump(''), false);
  assert.equal(needsVersionBump('   \n  '), false);
});

test('změna textu bez zvýšení verze neprojde', () => {
  const diff = [
    'diff --git a/src/prompts.ts b/src/prompts.ts',
    '-  \'Jsi recruiter screener. Hodnotíš...\'',
    '+  \'Jsi přísný recruiter screener. Hodnotíš...\'',
  ].join('\n');
  assert.equal(needsVersionBump(diff), true);
});

test('změna textu se zvýšenou verzí projde', () => {
  const diff = [
    'diff --git a/src/prompts.ts b/src/prompts.ts',
    "-export const PROMPT_VERSION = 'skore-2026-08-31.1';",
    "+export const PROMPT_VERSION = 'skore-2026-09-01.1';",
    '-  \'Jsi recruiter screener...\'',
    '+  \'Jsi přísný recruiter screener...\'',
  ].join('\n');
  assert.equal(needsVersionBump(diff), false);
});

test('samotné odebrání řádku s verzí nestačí — musí přibýt nová', () => {
  // Jinak by smazání konstanty prošlo jako „změněno".
  const diff = ['-export const PROMPT_VERSION = \'skore-2026-08-31.1\';'].join('\n');
  assert.equal(needsVersionBump(diff), true);
});

test('změna jen v komentáři se počítá taky — rozhoduje, že se soubor promptů hnul', () => {
  const diff = ['+// poznámka k promptu'].join('\n');
  assert.equal(needsVersionBump(diff), true);
});
