import { type FoundMachine, discoverEsphome, discoverNoble, suggestedConfig } from './discovery.js';
import { Machine } from './machine.js';
import { guessModel, modelByProductCode, recipesFor } from './models.js';
import { EsphomeTransport, type EsphomeOptions } from './transports/esphome.js';
import { NobleTransport } from './transports/noble.js';
import type { BleTransport, Logger } from './transports/transport.js';

export type TransportConfig =
  | { type: 'noble'; scanTimeoutMs?: number }
  | ({ type: 'esphome' } & EsphomeOptions);

export interface MachineSetup {
  /** Topic/identifier-safe id. */
  id: string;
  name?: string;
  /** MAC address. Optional: the first machine found is used when omitted. */
  address?: string;
  /** Advertised name, e.g. "D1533201" (matched by noble on macOS, used to guess the model). */
  bleName?: string;
  /** Catalog product code, e.g. "0132215332". Guessed from bleName when omitted. */
  productCode?: string;
  transport: TransportConfig;
  allowPowerOff?: boolean;
  autoPowerOn?: boolean;
  pollIntervalSec?: number;
  statsIntervalSec?: number;
  /** Per-beverage overrides, e.g. {"Cappuccino": {"coffeeQty": 90, "milkQty": 200, "taste": 4}} */
  recipeOverrides?: Record<string, { coffeeQty?: number; milkQty?: number; hotWaterQty?: number; taste?: number }>;
}

/** Static description of a machine, as published on `<base>/<id>/info`. */
export interface MachineInfo {
  id: string;
  name: string;
  model: string;
  product_code: string | null;
  image_url: string | null;
  beverages: string[];
  features: {
    power_off: boolean;
    auto_power_on: boolean;
    cup_light: boolean;
    sounds: boolean;
    energy_save: boolean;
    auto_off: boolean;
    water_hardness: boolean;
    filter: boolean;
  };
}

/**
 * Fill in address / name / product code when the setup does not identify the
 * machine, by listening for the first De'Longhi machine. Retries until found.
 */
export async function identifyMachine(setup: MachineSetup, log: Logger): Promise<void> {
  const needs = setup.transport.type === 'esphome' ? !setup.address : !setup.address && !setup.bleName;
  if (!needs) return;
  log.info(`[${setup.id}] no machine configured: searching (close the De'Longhi app on your phone)...`);
  for (;;) {
    let found: FoundMachine[] = [];
    try {
      found =
        setup.transport.type === 'esphome'
          ? await discoverEsphome(setup.transport, 60, undefined, true)
          : await discoverNoble(60, undefined, true);
    } catch (err) {
      log.warn(`[${setup.id}] search failed: ${(err as Error).message}`);
      await new Promise(r => setTimeout(r, 30_000));
      continue;
    }
    const m = found.find(f => f.bleName) ?? found[0];
    if (m) {
      setup.address ??= m.address || undefined;
      setup.bleName ??= m.bleName || undefined;
      setup.productCode ??= m.productCode;
      log.info(
        `[${setup.id}] found ${m.bleName || m.address} (${m.model ?? 'unknown model'}, rssi ${m.rssi}). ` +
          `Add to the configuration to skip the search: ${JSON.stringify(suggestedConfig(m))}`,
      );
      return;
    }
    log.warn(`[${setup.id}] no De'Longhi machine found yet, retrying`);
  }
}

/** Build a Machine (not started) from an identified setup. */
export function createMachine(setup: MachineSetup, log: Logger): Machine {
  const model = modelByProductCode(setup.productCode) ?? guessModel(setup.bleName);
  if (model) log.info(`[${setup.id}] model: ${model.name} (${model.productCode})`);
  else log.warn(`[${setup.id}] model unknown, only basic beverages available (set productCode)`);

  const recipes = recipesFor(model).map(r => ({ ...r, ...(setup.recipeOverrides?.[r.name] ?? {}) }));
  const target = { address: setup.address, bleName: setup.bleName };
  const transport: BleTransport =
    setup.transport.type === 'esphome'
      ? new EsphomeTransport(target, setup.transport, log)
      : new NobleTransport(target, log, { scanTimeoutMs: setup.transport.scanTimeoutMs });

  return new Machine(
    {
      id: setup.id,
      name: setup.name ?? model?.name ?? "De'Longhi",
      model,
      recipes,
      allowPowerOff: setup.allowPowerOff ?? false,
      autoPowerOn: setup.autoPowerOn ?? true,
      pollIntervalMs: (setup.pollIntervalSec ?? 30) * 1000,
      statsIntervalMs: (setup.statsIntervalSec ?? 600) * 1000,
    },
    transport,
    log,
  );
}

export function machineInfo(m: Machine): MachineInfo {
  const model = m.opts.model;
  return {
    id: m.opts.id,
    name: m.opts.name,
    model: model?.name ?? "De'Longhi coffee machine",
    product_code: model?.productCode ?? null,
    image_url: model?.imageUrl ?? null,
    beverages: m.beverages,
    features: {
      power_off: m.opts.allowPowerOff,
      auto_power_on: m.opts.autoPowerOn,
      cup_light: model?.cupLight ?? false,
      sounds: model?.buzzer ?? true,
      energy_save: model?.energySaving ?? true,
      auto_off: model?.autoOff ?? true,
      water_hardness: model?.waterHardness ?? true,
      filter: model?.filter ?? true,
    },
  };
}
