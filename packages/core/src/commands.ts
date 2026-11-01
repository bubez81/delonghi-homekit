import type { Machine } from './machine.js';
import { hex } from './protocol.js';

export interface CommandResult {
  /** Reply frame for `raw`. */
  reply?: string | null;
}

/**
 * Run a named command on a machine. Shared by the MQTT bridge
 * (`<base>/<id>/set/<command>`) and the Homebridge plugin.
 */
export async function executeCommand(m: Machine, command: string, value = ''): Promise<CommandResult> {
  const on = /^(on|true|1)$/i.test(value.trim());
  switch (command) {
    case 'power':
      if (on) await m.powerOn();
      else await m.powerOff();
      return {};
    case 'power_on':
      await m.powerOn();
      return {};
    case 'power_off':
      await m.powerOff();
      return {};
    case 'brew':
    case 'beverage':
      if (!value || value === 'none') await m.cancelBeverage();
      else await m.brewBeverage(value);
      return {};
    case 'cancel':
      await m.cancelBeverage();
      return {};
    case 'profile':
      await m.selectProfile(value);
      return {};
    case 'sounds':
    case 'energy_save':
    case 'cup_light':
      await m.setSwitchSetting(command, on);
      return {};
    case 'auto_off':
      await m.setAutoOff(value);
      return {};
    case 'water_hardness':
      await m.setWaterHardness(value);
      return {};
    case 'water_temperature':
      await m.setWaterTemperature(value);
      return {};
    case 'refresh':
      await m.readSettings();
      await m.refreshStatistics(true);
      return {};
    case 'raw': {
      const reply = await m.sendRaw(value);
      return { reply: reply ? hex(reply) : null };
    }
    default:
      throw new Error(`unknown command "${command}"`);
  }
}
