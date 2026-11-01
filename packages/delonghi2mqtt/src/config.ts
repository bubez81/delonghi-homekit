import { readFileSync } from 'node:fs';
import type { MqttOptions } from './bridge.js';
import type { EsphomeOptions } from './transports/esphome.js';

export type TransportConfig = ({ type: 'noble' } & { scanTimeoutMs?: number }) | ({ type: 'esphome' } & EsphomeOptions);

export interface MachineConfig {
  /** Topic-safe id, e.g. "dinamica". */
  id: string;
  name?: string;
  /** BLE MAC address. Optional: the first machine found is used when omitted. */
  address?: string;
  /** Advertised name, e.g. "D1533201" (used by noble on macOS, and to guess the model). */
  bleName?: string;
  /** Product code from the catalog, e.g. "0132215332". Guessed from bleName when omitted. */
  productCode?: string;
  transport: TransportConfig;
  allowPowerOff?: boolean;
  autoPowerOn?: boolean;
  pollIntervalSec?: number;
  statsIntervalSec?: number;
  /** Per-beverage overrides, e.g. {"Cappuccino": {"coffeeQty": 90, "milkQty": 200, "taste": 4}} */
  recipeOverrides?: Record<string, { coffeeQty?: number; milkQty?: number; hotWaterQty?: number; taste?: number }>;
}

export interface Config {
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  mqtt: Partial<MqttOptions> & { url: string };
  machines: MachineConfig[];
}

export function loadConfig(path: string): Config {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as Config;
  if (!cfg.mqtt?.url) throw new Error('config: mqtt.url is required');
  if (!Array.isArray(cfg.machines) || cfg.machines.length === 0) throw new Error('config: at least one machine is required');
  // Secrets may come from the environment instead of the file.
  cfg.mqtt.username ??= process.env.MQTT_USERNAME;
  cfg.mqtt.password ??= process.env.MQTT_PASSWORD;
  for (const m of cfg.machines) {
    if (!/^[a-z0-9_-]+$/i.test(m.id ?? '')) throw new Error(`config: invalid machine id "${m.id}"`);
    if (!m.transport?.type) throw new Error(`config: machine ${m.id} needs a transport`);
    if (m.transport.type === 'esphome') {
      if (!m.transport.host) throw new Error(`config: machine ${m.id}: esphome transport needs host`);
      m.transport.encryptionKey ??= process.env.ESPHOME_API_KEY;
    }
  }
  return cfg;
}
