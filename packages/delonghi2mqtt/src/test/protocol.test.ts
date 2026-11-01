import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMMANDS,
  FrameAssembler,
  LEGACY_START,
  hasValidCrc,
  hex,
  isDispensing,
  parseHex,
  parseMonitor,
  parseSettingRead,
  parseStatistics,
  recipeStartCommand,
  withCrc,
} from '../protocol.js';
import { guessModel, recipesFor } from '../models.js';

// Frames observed in the HA logs / DEBUG_NOTES of the original integration.
const KNOWN = {
  statusPoll: '0d 05 75 0f da 25',
  readSettings: '0d 08 95 0f 00 3f 01 2b 83',
  stats100: '0d 08 a2 0f 00 64 0a 23 97',
  stats3000: '0d 08 a2 0f 0b b8 0a 83 2c',
  settingsReply: 'd0 0b 95 0f 00 3f 00 00 00 95 3a 93',
  off: 'd0 12 75 0f 01 01 00 00 00 00 03 64 00 00 00 00 00 d6 96',
  ready: 'd0 12 75 0f 01 05 00 00 00 07 00 00 00 00 00 00 00 9d 61',
  noTank: 'd0 12 75 0f 01 15 00 00 00 07 00 00 00 00 00 00 00 aa 31',
  freshWater: 'd0 12 75 0f 01 45 00 01 00 07 00 00 00 00 00 00 00 2f 64',
  hotWater: 'd0 12 75 0f 01 05 00 00 00 0b 03 07 00 00 00 00 00 9c 15',
  stats: 'd0 41 a2 0f 00 64 00 03 95 a5 00 65 00 00 00 0f 00 69 00 00 00 11 00 6a 00 19 fb 25 00 6c 00 00 00 09 00 6d 00 00 38 2f 00 6f 00 00 00 13 00 74 00 00 01 a7 01 a7 00 00 00 00 0b b8 00 00 10 9f c5 03',
};

test('built commands match captured frames byte for byte', () => {
  assert.equal(hex(COMMANDS.statusPoll()), KNOWN.statusPoll);
  assert.equal(hex(COMMANDS.readSettings()), KNOWN.readSettings);
  assert.equal(hex(COMMANDS.statistics(100, 10)), KNOWN.stats100);
  assert.equal(hex(COMMANDS.statistics(3000, 10)), KNOWN.stats3000);
});

test('captured responses have valid CRCs', () => {
  for (const f of Object.values(KNOWN)) assert.ok(hasValidCrc(parseHex(f)), f);
});

test('legacy beverage frames keep their original CRC', () => {
  // ESPRESSO_ON / COFFE_OFF style frames from const.py carry real CRCs.
  assert.equal(hex(withCrc(LEGACY_START[1])).slice(-5), '8f fc');
  assert.equal(hex(withCrc(LEGACY_START[16])).slice(-5), '04 b4');
  assert.equal(hex(withCrc(LEGACY_START[6])).slice(-5), '47 8b');
});

test('stop frame matches captured COFFE_OFF', () => {
  // COFFE_OFF = 0d 08 83 f0 02 02 06 c4 b1
  assert.equal(hex(withCrc([0x0d, 0x08, 0x83, 0xf0, 0x02, 0x02, 0x06, 0, 0])), '0d 08 83 f0 02 02 06 c4 b1');
});

test('monitor parsing', () => {
  const off = parseMonitor(parseHex(KNOWN.off))!;
  assert.equal(off.status, 0);
  const ready = parseMonitor(parseHex(KNOWN.ready))!;
  assert.equal(ready.status, 7);
  assert.equal(ready.nozzle, 1);
  assert.deepEqual(ready.alarms, []);
  assert.equal(isDispensing(ready), false);
  assert.ok(parseMonitor(parseHex(KNOWN.noTank))!.switches.includes('water_tank_absent'));
  const fresh = parseMonitor(parseHex(KNOWN.freshWater))!;
  assert.deepEqual(fresh.alarms, ['empty_water_tank']);
  assert.ok(fresh.switches.includes('water_level_low'));
  assert.equal(isDispensing(parseMonitor(parseHex(KNOWN.hotWater))!), true);
});

test('settings and statistics parsing', () => {
  assert.deepEqual(parseSettingRead(parseHex(KNOWN.settingsReply)), { param: 0x3f, value: 0x95 });
  const s = parseStatistics(parseHex(KNOWN.stats));
  assert.equal(s.get(100), 0x395a5);
  assert.equal(s.get(106), 0x19fb25);
  assert.equal(s.get(3000), 0x109f);
});

test('assembler splits and joins chunks', () => {
  const a = new FrameAssembler();
  const f = parseHex(KNOWN.ready);
  assert.equal(a.push(f.subarray(0, 7)).length, 0);
  const out = a.push(Buffer.concat([f.subarray(7), Buffer.from([0x00]), parseHex(KNOWN.off)]));
  assert.equal(out.length, 2);
  assert.equal(hex(out[1]), KNOWN.off);
});

test('model guess and recipes for Dinamica Plus D1533201', () => {
  const m = guessModel('D1533201')!;
  assert.equal(m.productCode, '0132215332');
  const r = recipesFor(m);
  assert.ok(r.some(x => x.name === 'Cappuccino'));
  assert.ok(r.some(x => x.name === 'Custom 3'));
  const capp = r.find(x => x.name === 'Cappuccino')!;
  // coffee 80 (0x0050), milk 160 (0x00a0), taste 3
  assert.equal(hex(recipeStartCommand(capp)).slice(0, 44), '0d 10 83 f0 07 01 01 00 50 09 00 a0 02 03 06');
  const hw = r.find(x => x.id === 16)!;
  assert.equal(hex(recipeStartCommand(hw)), '0d 0d 83 f0 10 01 0f 00 fa 1c 01 06 04 b4');
});
