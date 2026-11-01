import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import {
  type Machine,
  type MachineInfo,
  type MachineSetup,
  type MachineState,
  createMachine,
  executeCommand,
  identifyMachine,
  machineInfo,
} from 'delonghi-core';
import mqtt, { type MqttClient } from 'mqtt';
import { type AccessoryOptions, CoffeeAccessory, type MachineLink } from './accessory.js';

export const PLUGIN_NAME = 'homebridge-delonghi-coffee';
export const PLATFORM_NAME = 'DelonghiCoffee';

export interface MachineConfig extends AccessoryOptions {
  name?: string;
  /** esphome: ESPHome Bluetooth proxy; local: this server's Bluetooth; mqtt: a delonghi2mqtt bridge. */
  connection?: 'esphome' | 'local' | 'mqtt';
  esphomeHost?: string;
  esphomePort?: number;
  esphomeKey?: string;
  address?: string;
  bleName?: string;
  productCode?: string;
  allowPowerOff?: boolean;
  autoPowerOn?: boolean;
  recipeOverrides?: MachineSetup['recipeOverrides'];
  /** mqtt: machine id used by the bridge (topic delonghi/<id>/...). */
  mqttId?: string;
  /** Stable id for the HomeKit accessory. Defaults to a slug of the name. */
  id?: string;
}

interface DelonghiConfig extends PlatformConfig {
  machines?: MachineConfig[];
  mqtt?: { url?: string; username?: string; password?: string; baseTopic?: string };
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

export class DelonghiPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly machines: Machine[] = [];
  private mqtt?: MqttClient;
  private pending = 0;

  constructor(
    readonly log: Logging,
    readonly config: DelonghiConfig,
    readonly api: API,
  ) {
    api.on('didFinishLaunching', () => void this.start());
    api.on('shutdown', () => {
      for (const m of this.machines) void m.stop();
      void this.mqtt?.endAsync();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  takeCached(uuid: string): PlatformAccessory | undefined {
    const a = this.cached.get(uuid);
    this.cached.delete(uuid);
    return a;
  }

  registerAccessory(acc: PlatformAccessory): void {
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
  }

  private async start(): Promise<void> {
    const list = this.config.machines ?? [];
    if (list.length === 0) {
      this.log.warn('no machines configured');
    }
    this.pending = list.length;
    const used = new Set<string>();
    list.forEach((mc, i) => {
      let key = mc.id || slug(mc.name ?? '') || 'coffee';
      if (used.has(key)) key = `${key}_${i + 1}`;
      used.add(key);
      const settle = () => this.settled();
      if ((mc.connection ?? 'esphome') === 'mqtt') this.startMqtt(key, mc, settle);
      else void this.startDirect(key, mc, settle);
    });
    if (list.length === 0) this.settled();
  }

  /** Remove cached accessories nobody claimed once every machine is set up. */
  private settled(): void {
    if (--this.pending > 0) return;
    if (this.cached.size === 0) return;
    const stale = [...this.cached.values()];
    this.log.info(`removing ${stale.length} stale accessories`);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    this.cached.clear();
  }

  // ------------------------------------------------------------ direct BLE

  private async startDirect(key: string, mc: MachineConfig, settle: () => void): Promise<void> {
    const connection = mc.connection ?? 'esphome';
    if (connection === 'esphome' && !mc.esphomeHost) {
      this.log.error(`[${key}] esphomeHost is required for the ESPHome connection`);
      settle();
      return;
    }
    const setup: MachineSetup = {
      id: key,
      name: mc.name,
      address: mc.address,
      bleName: mc.bleName,
      productCode: mc.productCode,
      allowPowerOff: mc.allowPowerOff,
      autoPowerOn: mc.autoPowerOn,
      recipeOverrides: mc.recipeOverrides,
      transport:
        connection === 'local'
          ? { type: 'noble' }
          : { type: 'esphome', host: mc.esphomeHost!, port: mc.esphomePort, encryptionKey: mc.esphomeKey },
    };

    try {
      await identifyMachine(setup, this.log);
    } catch (err) {
      this.log.error(`[${key}] ${(err as Error).message}`);
      settle();
      return;
    }
    const machine = createMachine(setup, this.log);
    this.machines.push(machine);

    const link: MachineLink = {
      info: machineInfo(machine),
      state: machine.state,
      online: () => machine.state.connected,
      send: (command, value = '') => {
        executeCommand(machine, command, value).catch(err =>
          this.log.warn(`[${key}] ${command} failed: ${(err as Error).message}`),
        );
      },
    };
    const accessory = new CoffeeAccessory(this, key, mc.name ?? link.info.name, mc, link);
    machine.on('state', () => accessory.refresh());
    machine.start();
    settle();
  }

  // ------------------------------------------------------------------ MQTT

  private mqttClient(): MqttClient | undefined {
    if (this.mqtt) return this.mqtt;
    const cfg = this.config.mqtt;
    if (!cfg?.url) {
      this.log.error('mqtt.url is required for machines with connection "mqtt"');
      return undefined;
    }
    const client = mqtt.connect(cfg.url, {
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      clientId: `homebridge-delonghi_${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 5_000,
    });
    client.on('connect', () => this.log.info(`MQTT connected to ${cfg.url}`));
    client.on('error', e => this.log.warn(`MQTT: ${e.message}`));
    this.mqtt = client;
    return client;
  }

  private startMqtt(key: string, mc: MachineConfig, settle: () => void): void {
    const client = this.mqttClient();
    if (!client) {
      settle();
      return;
    }
    const base = this.config.mqtt?.baseTopic ?? 'delonghi';
    const id = mc.mqttId ?? key;
    let bridgeOnline = true;
    let accessory: CoffeeAccessory | undefined;
    let settledOnce = false;
    const settleOnce = () => {
      if (!settledOnce) {
        settledOnce = true;
        settle();
      }
    };
    setTimeout(() => {
      if (!accessory) this.log.warn(`[${key}] nothing received on ${base}/${id}/info yet (is delonghi2mqtt running?)`);
      settleOnce();
    }, 60_000);

    const link: MachineLink = {
      info: undefined as unknown as MachineInfo,
      online: () => bridgeOnline && !!link.state?.connected,
      send: (command, value = '') => client.publish(`${base}/${id}/set/${command}`, value),
    };

    const topics = [`${base}/bridge/state`, `${base}/${id}/info`, `${base}/${id}/state`, `${base}/${id}/event`];
    client.on('connect', () => client.subscribe(topics));
    if (client.connected) client.subscribe(topics);

    client.on('message', (topic, payload) => {
      const text = payload.toString();
      if (topic === `${base}/bridge/state`) {
        bridgeOnline = text === 'online';
        accessory?.refresh();
        return;
      }
      if (!topic.startsWith(`${base}/${id}/`)) return;
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }
      if (topic.endsWith('/info')) {
        link.info = data as MachineInfo;
        if (!accessory) {
          accessory = new CoffeeAccessory(this, key, mc.name ?? link.info.name, mc, link);
          settleOnce();
        } else {
          accessory.infoChanged();
        }
      } else if (topic.endsWith('/state')) {
        link.state = data as MachineState;
        accessory?.refresh();
      } else if (topic.endsWith('/event') && data.type === 'error') {
        this.log.warn(`[${key}] ${data.command}: ${data.message}`);
      }
    });
  }
}
