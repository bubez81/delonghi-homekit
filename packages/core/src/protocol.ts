/**
 * De'Longhi ECAM BLE protocol.
 *
 * Ported from home_assistant_delonghi_primadonna by Sergey Arbuzov and
 * contributors (https://github.com/Arbuzov/home_assistant_delonghi_primadonna,
 * Apache-2.0),
 * custom_components/delonghi_primadonna/{const,device,machine_switch}.py.
 *
 * Framing:
 *   request  0x0d <len> <cmd> <sub> ...payload... <crc_hi> <crc_lo>
 *   response 0xd0 <len> <cmd> <sub> ...payload... <crc_hi> <crc_lo>
 * where <len> is total length - 1 and the CRC is CRC-16/CCITT
 * (poly 0x1021, init 0x1D0F) over everything except the CRC itself.
 */

export const SERVICE_UUID = '00035b03-58e6-07dd-021a-08123a000300';
export const CONTROL_CHAR_UUID = '00035b03-58e6-07dd-021a-08123a000301';
export const CCCD_UUID = '00002902-0000-1000-8000-00805f9b34fb';

export const REQUEST_START = 0x0d;
export const RESPONSE_START = 0xd0;

export const CMD = {
  MONITOR_V1: 0x70,
  MONITOR_V2: 0x75,
  BEVERAGE: 0x83,
  APP_CONTROL: 0x84,
  WRITE_SETTING: 0x90,
  READ_SETTING: 0x95,
  STATISTICS: 0xa2,
  PROFILE_NAMES: 0xa4,
  PROFILE_SELECT: 0xa9,
  CLOCK: 0xe2,
} as const;

export function crc16(data: Uint8Array): number {
  let crc = 0x1d0f;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Build a request frame from command bytes (without start/len/crc). */
export function frame(body: number[]): Buffer {
  const len = body.length + 3; // start + len + crc(2) - 1
  const bytes = [REQUEST_START, len, ...body];
  const crc = crc16(Uint8Array.from(bytes));
  return Buffer.from([...bytes, (crc >> 8) & 0xff, crc & 0xff]);
}

/** Recompute the CRC of a complete frame (last two bytes are replaced). */
export function withCrc(full: number[] | Uint8Array): Buffer {
  const bytes = Buffer.from(full);
  const crc = crc16(bytes.subarray(0, bytes.length - 2));
  bytes[bytes.length - 2] = (crc >> 8) & 0xff;
  bytes[bytes.length - 1] = crc & 0xff;
  return bytes;
}

export function hasValidCrc(packet: Uint8Array): boolean {
  if (packet.length < 4) return false;
  const expected = (packet[packet.length - 2] << 8) | packet[packet.length - 1];
  return crc16(packet.subarray(0, packet.length - 2)) === expected;
}

export function hex(buf: Uint8Array): string {
  return Buffer.from(buf).toString('hex').replace(/(..)(?!$)/g, '$1 ');
}

export function parseHex(text: string): Buffer {
  const clean = text.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2 !== 0) throw new Error('odd number of hex digits');
  return Buffer.from(clean, 'hex');
}

/**
 * Reassembles notification chunks into complete, CRC-checked frames.
 * BLE notifications may split a frame (MTU 20) or carry several.
 */
export class FrameAssembler {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames: Buffer[] = [];
    for (;;) {
      const start = this.buffer.indexOf(RESPONSE_START);
      if (start < 0) {
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (start > 0) this.buffer = this.buffer.subarray(start);
      if (this.buffer.length < 2) break;
      const len = this.buffer[1] + 1;
      if (this.buffer.length < len) break;
      const packet = Buffer.from(this.buffer.subarray(0, len));
      if (!hasValidCrc(packet)) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      this.buffer = this.buffer.subarray(len);
      frames.push(packet);
    }
    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

// ---------------------------------------------------------------- monitor

export const MACHINE_STATUS: Record<number, string> = {
  0: 'turned_off',
  1: 'heating',
  2: 'shutting_down',
  3: 'heating',
  4: 'descaling',
  5: 'delivering_steam',
  6: 'brewing',
  7: 'ready',
  8: 'rinsing',
  10: 'preparing',
  11: 'delivering_hot_water',
  12: 'cleaning_milk_spout',
  14: 'changing_filter',
};

/** Alarm bit -> key. */
export const ALARMS: Record<number, string> = {
  0: 'empty_water_tank',
  1: 'coffee_waste_container_full',
  2: 'descale_alarm',
  3: 'replace_water_filter',
  4: 'coffee_ground_too_fine',
  5: 'coffee_beans_empty',
  6: 'machine_to_service',
  7: 'coffee_heater_probe_failure',
  8: 'too_much_coffee',
  9: 'coffee_infuser_motor_not_working',
  10: 'steamer_probe_failure',
  11: 'empty_drip_tray',
  12: 'hydraulic_circuit_problem',
  13: 'tank_is_in_position',
  14: 'clean_knob',
  15: 'coffee_beans_empty_two',
  16: 'tank_too_full',
  17: 'bean_hopper_absent',
  18: 'grid_presence',
  19: 'infuser_sense',
  20: 'not_enough_coffee',
  21: 'expansion_comm_prob',
  22: 'expansion_submodules_prob',
  23: 'grinding_unit_1_problem',
  24: 'grinding_unit_2_problem',
  25: 'condense_fan_problem',
  26: 'clock_bt_comm_problem',
  27: 'spi_comm_problem',
};

export const NOZZLE_STATE: Record<number, string> = {
  0: 'detached',
  1: 'steam',
  2: 'milk_frother',
  3: 'milk_frother_cleaning',
  4: 'carafe_needs_cleaning',
  6: 'chocolate_container',
  7: 'chocolate_container_needs_cleaning',
};

/** Switch (sensor) bit -> key; bits set mean "open/absent/low". */
const SWITCH_BITS: Record<number, string> = {
  0: 'water_spout',
  1: 'motor_up',
  2: 'motor_down',
  3: 'coffee_waste_container',
  4: 'water_tank_absent',
  5: 'knob',
  6: 'water_level_low',
  7: 'coffee_jug',
  8: 'ifd_caraffe',
  9: 'ciocco_tank',
  10: 'clean_knob',
  13: 'door_opened',
  14: 'preground_door_opened',
};
const HIDDEN_SWITCHES = new Set(['water_spout', 'ifd_caraffe', 'ciocco_tank']);

export interface MonitorData {
  version: 1 | 2;
  switchesMask: number;
  switches: string[];
  alarmsMask: number;
  alarms: string[];
  status: number;
  subStatus: number;
  nozzle: number; // -1 when unknown (v1)
  percentage: number;
}

export function parseSwitches(lo: number, hi: number): string[] {
  let mask = lo | (hi << 8);
  if (hi & 0x08) {
    mask &= ~(1 << 2);
    mask &= ~(1 << 9);
  }
  const out: string[] = [];
  for (let bit = 0; bit < 16; bit++) {
    if (!(mask & (1 << bit))) continue;
    const key = SWITCH_BITS[bit];
    if (key && !HIDDEN_SWITCHES.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

export function alarmList(mask: number): string[] {
  const out: string[] = [];
  for (let bit = 0; bit < 32; bit++) {
    if ((mask >>> bit) & 1) out.push(ALARMS[bit] ?? `alarm_${bit}`);
  }
  return out;
}

export function parseMonitor(data: Uint8Array): MonitorData | undefined {
  if (data.length < 3) return undefined;
  if (data[2] === CMD.MONITOR_V2) {
    if (data.length < 14) return undefined;
    const alarmsMask =
      (data[7] | (data[8] << 8) | (data[12] << 16) | (data[13] << 24)) >>> 0;
    return {
      version: 2,
      switchesMask: data[5] | (data[6] << 8),
      switches: parseSwitches(data[5], data[6]),
      alarmsMask,
      alarms: alarmList(alarmsMask),
      status: data[9],
      subStatus: data[10],
      nozzle: data[4],
      percentage: data[11],
    };
  }
  if (data[2] === CMD.MONITOR_V1) {
    if (data.length < 11) return undefined;
    const alarmsMask = data[4] | (data[5] << 8);
    return {
      version: 1,
      switchesMask: data[9] | (data[10] << 8),
      switches: [],
      alarmsMask,
      alarms: alarmList(alarmsMask),
      status: data[8],
      subStatus: data[9],
      nozzle: -1,
      percentage: 0,
    };
  }
  return undefined;
}

/**
 * Dispensing: steam (5), milk (10) and hot water (11) are their own states;
 * 7 ("ready") with a non-zero sub status means a coffee is running.
 */
export function isDispensing(m: MonitorData): boolean {
  return [5, 10, 11].includes(m.status) || (m.status === 7 && m.subStatus !== 0);
}

// --------------------------------------------------------------- commands

export const COMMANDS = {
  statusPoll: () => frame([CMD.MONITOR_V2, 0x0f]),
  powerOn: () => frame([CMD.APP_CONTROL, 0x0f, 0x02, 0x01]),
  /** Standby: only verified on some models (not on Dinamica Plus 370.95). */
  powerOff: () => frame([CMD.APP_CONTROL, 0x0f, 0x01, 0x01]),
  readSettings: () => frame([CMD.READ_SETTING, 0x0f, 0x00, 0x3f, 0x01]),
  readSetting: (param: number) => frame([CMD.READ_SETTING, 0x0f, (param >> 8) & 0xff, param & 0xff, 0x01]),
  writeSetting: (param: number, value: number) =>
    frame([CMD.WRITE_SETTING, 0x0f, (param >> 8) & 0xff, param & 0xff, 0x00, 0x00, 0x00, value & 0xff]),
  statistics: (start: number, count: number) =>
    frame([CMD.STATISTICS, 0x0f, (start >> 8) & 0xff, start & 0xff, count & 0xff]),
  profileNames: (first: number, last: number) => frame([CMD.PROFILE_NAMES, 0xf0, first, last]),
  selectProfile: (id: number) => frame([CMD.PROFILE_SELECT, 0xf0, id & 0xff]),
  setClock: (hour: number, minute: number) => frame([CMD.CLOCK, 0xf0, hour & 0xff, minute & 0xff]),
};

export const SETTING = {
  WATER_HARDNESS: 0x32,
  AUTO_OFF: 0x3e,
  WATER_TEMPERATURE: 0x3d,
  SWITCHES: 0x3f,
} as const;

export const SETTINGS_BITS = {
  sounds: 0x04,
  cup_light: 0x08,
  energy_save: 0x10,
} as const;

export const AUTO_OFF_OPTIONS: Record<string, number> = {
  '15min': 0,
  '30min': 1,
  '1h': 2,
  '2h': 3,
  '3h': 4,
};
export const WATER_HARDNESS_OPTIONS = ['soft', 'medium', 'hard', 'very_hard'];
export const WATER_TEMPERATURE_OPTIONS = ['low', 'medium', 'high', 'highest'];

/** Ingredient ids (see longshot EcamIngredients). Quantities are 16 bit. */
export const INGREDIENT = {
  TEMP: 0x00,
  COFFEE: 0x01,
  TASTE: 0x02,
  DUEXPER: 0x08,
  MILK: 0x09,
  HOT_WATER: 0x0f,
  ACCESSORY: 0x1c,
} as const;
const WIDE_INGREDIENTS = new Set<number>([INGREDIENT.COFFEE, INGREDIENT.MILK, INGREDIENT.HOT_WATER]);

export type Ingredients = Array<[id: number, value: number]>;

export function beverageStart(recipeId: number, ingredients: Ingredients): Buffer {
  const body: number[] = [CMD.BEVERAGE, 0xf0, recipeId & 0xff, 0x01];
  for (const [id, value] of ingredients) {
    body.push(id);
    if (WIDE_INGREDIENTS.has(id)) body.push((value >> 8) & 0xff);
    body.push(value & 0xff);
  }
  body.push(0x06);
  return frame(body);
}

export function beverageStop(recipeId: number): Buffer {
  return frame([CMD.BEVERAGE, 0xf0, recipeId & 0xff, 0x02, 0x06]);
}

/**
 * Captured "legacy" start commands from the original integration, keyed by
 * recipe id. They are known to work, so they take precedence over the
 * generated ones. CRCs are recomputed.
 */
export const LEGACY_START: Record<number, number[]> = {
  1: [0x0d, 0x11, 0x83, 0xf0, 0x01, 0x01, 0x01, 0x00, 0x28, 0x02, 0x03, 0x08, 0x00, 0x00, 0x00, 0x06, 0, 0],
  2: [0x0d, 0x0f, 0x83, 0xf0, 0x02, 0x01, 0x01, 0x00, 0x67, 0x02, 0x02, 0x00, 0x00, 0x06, 0, 0],
  3: [0x0d, 0x0f, 0x83, 0xf0, 0x03, 0x01, 0x01, 0x00, 0xa0, 0x02, 0x03, 0x00, 0x00, 0x06, 0, 0],
  4: [0x0d, 0x0f, 0x83, 0xf0, 0x04, 0x01, 0x01, 0x00, 0x28, 0x02, 0x02, 0x00, 0x00, 0x06, 0, 0],
  5: [0x0d, 0x0d, 0x83, 0xf0, 0x05, 0x01, 0x01, 0x00, 0x78, 0x00, 0x00, 0x06, 0, 0],
  6: [0x0d, 0x12, 0x83, 0xf0, 0x06, 0x01, 0x01, 0x00, 0x28, 0x02, 0x03, 0x0f, 0x00, 0x6e, 0x00, 0x00, 0x06, 0, 0],
  16: [0x0d, 0x0d, 0x83, 0xf0, 0x10, 0x01, 0x0f, 0x00, 0xfa, 0x1c, 0x01, 0x06, 0, 0],
  17: [0x0d, 0x0d, 0x83, 0xf0, 0x11, 0x01, 0x09, 0x03, 0x84, 0x1c, 0x01, 0x06, 0, 0],
};

export interface RecipeSpec {
  id: number;
  name: string;
  coffeeQty: number;
  milkQty: number;
  taste?: number;
  hotWaterQty?: number;
}

/** Build the start command for a recipe, preferring captured frames. */
/**
 * Build the start command for a recipe, preferring captured frames.
 *
 * Generated frames follow the Coffee Link capture documented in
 * home_assistant_delonghi_primadonna PR #281: tags in ascending order, and
 * for milk drinks the milk carafe accessory (`1c 02`) last. Milk quantities
 * are in tenths of a second, as in the catalog.
 */
export function recipeStartCommand(recipe: RecipeSpec, useLegacy = true): Buffer {
  if (useLegacy && LEGACY_START[recipe.id]) return withCrc(LEGACY_START[recipe.id]);
  const ing: Ingredients = [];
  if (recipe.coffeeQty > 0) ing.push([INGREDIENT.COFFEE, recipe.coffeeQty]);
  if (recipe.coffeeQty > 0) ing.push([INGREDIENT.TASTE, recipe.taste ?? 3]);
  if (recipe.milkQty > 0) ing.push([INGREDIENT.MILK, recipe.milkQty]);
  if (recipe.hotWaterQty && recipe.hotWaterQty > 0) ing.push([INGREDIENT.HOT_WATER, recipe.hotWaterQty]);
  if (recipe.milkQty > 0) ing.push([INGREDIENT.ACCESSORY, 2]);
  else if (recipe.coffeeQty === 0) ing.push([INGREDIENT.ACCESSORY, 1]);
  return beverageStart(recipe.id, ing);
}

/** The machine's ATT MTU is 23: longer frames are written in 20-byte chunks. */
export const MAX_WRITE = 20;

export function chunks(frame: Uint8Array, size = MAX_WRITE): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < frame.length; i += size) out.push(Buffer.from(frame.subarray(i, i + size)));
  return out;
}

// --------------------------------------------------------------- responses

/** Statistics response: d0 len a2 0f <id:2> <val:4> (<id:2> <val:4>)* crc */
export function parseStatistics(data: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  if (data.length < 12) return out;
  const view = Buffer.from(data);
  out.set(view.readUInt16BE(4), view.readUInt32BE(6));
  for (let off = 10; off + 6 <= data.length - 2; off += 6) {
    out.set(view.readUInt16BE(off), view.readUInt32BE(off + 2));
  }
  return out;
}

/** Settings read response: d0 0b 95 0f <param:2> b3 b2 b1 b0 crc */
export function parseSettingRead(data: Uint8Array): { param: number; value: number } | undefined {
  if (data.length < 12 || data[2] !== CMD.READ_SETTING) return undefined;
  return { param: (data[4] << 8) | data[5], value: data[9] };
}

/** Profile names: UTF-16BE, 20 bytes each, separated by one icon byte. */
export function parseProfileNames(data: Uint8Array, count: number, firstId = 1): Map<number, string> {
  const out = new Map<number, string>();
  const SIZE = 20;
  let idx = 4;
  for (let id = firstId; id < firstId + count; id++) {
    if (idx + SIZE > data.length - 2) break;
    const raw = Buffer.from(data.subarray(idx, idx + SIZE));
    idx += SIZE + 1;
    let end = raw.length;
    for (let p = 0; p + 1 < raw.length; p += 2) {
      if (raw[p] === 0 && raw[p + 1] === 0) {
        end = p;
        break;
      }
    }
    const swapped = Buffer.from(raw.subarray(0, end));
    swapped.swap16();
    const name = swapped.toString('utf16le').trim();
    if (name) out.set(id, name);
  }
  return out;
}
