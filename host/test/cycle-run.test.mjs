// Device-free tests for the Autostart unification feature (research/al80-buildout-flow-and-
// overnight-plan.md "Autostart unification"). Covers: cycle-run.mjs's --only=<panel> arg parsing,
// and that the autostart launcher (run-nowplaying.vbs) targets cycle-run.mjs, the superset host,
// not the old single-panel nowplaying-run.mjs. No board, no HID — pure argv/text checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from '../cycle-run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostDir = path.resolve(__dirname, '..');

test('parseArgs: no args -> rotates all panels, mock data', () => {
  const o = parseArgs([]);
  assert.equal(o.live, false);
  assert.equal(o.mockDevice, false);
  assert.equal(o.only, null);
  assert.deepEqual(o.panels, ['clock', 'weather', 'nowplaying']);
});

test('parseArgs: --live and --mock-device flags', () => {
  const o = parseArgs(['--live', '--mock-device']);
  assert.equal(o.live, true);
  assert.equal(o.mockDevice, true);
});

test('parseArgs: --only=nowplaying restricts to a single panel', () => {
  const o = parseArgs(['--only=nowplaying']);
  assert.equal(o.only, 'nowplaying');
  assert.deepEqual(o.panels, ['nowplaying']);
});

test('parseArgs: --only=weather and --only=clock also restrict to one panel', () => {
  assert.deepEqual(parseArgs(['--only=weather']).panels, ['weather']);
  assert.deepEqual(parseArgs(['--only=clock']).panels, ['clock']);
});

test('parseArgs: --only combines with --live', () => {
  const o = parseArgs(['--live', '--only=nowplaying']);
  assert.equal(o.live, true);
  assert.deepEqual(o.panels, ['nowplaying']);
});

test('parseArgs: unknown --only value throws (fails loud, not silently ignored)', () => {
  assert.throws(() => parseArgs(['--only=bogus']), /--only must be one of/);
});

test('autostart launcher (run-nowplaying.vbs) targets cycle-run.mjs, not nowplaying-run.mjs', () => {
  const vbs = readFileSync(path.join(hostDir, 'autostart', 'run-nowplaying.vbs'), 'utf8');
  const nodeArgsLine = vbs.split('\n').find((l) => /^\s*nodeArgs\s*=/.test(l));
  assert.ok(nodeArgsLine, 'expected a nodeArgs = ... line');
  assert.match(nodeArgsLine, /cycle-run\.mjs/, 'the executed launcher line should invoke cycle-run.mjs');
  assert.doesNotMatch(nodeArgsLine, /nowplaying-run\.mjs/, 'the executed launcher line should no longer target the single-panel script');
});

test('debug bat launcher also targets cycle-run.mjs', () => {
  const bat = readFileSync(path.join(hostDir, 'autostart', 'al80-nowplaying.bat'), 'utf8');
  assert.match(bat, /cycle-run\.mjs/);
});

test('no new scheduled task / startup registration was added by this feature', () => {
  // Guardrail: autostart unification repoints the EXISTING launcher; it must not add new
  // Register-ScheduledTask calls or startup-folder installers beyond what already existed.
  const readme = readFileSync(path.join(hostDir, 'autostart', 'README.md'), 'utf8');
  const registerCount = (readme.match(/Register-ScheduledTask/g) || []).length;
  assert.equal(registerCount, 1, 'exactly the one pre-existing documented Task Scheduler snippet, no new ones');
});
