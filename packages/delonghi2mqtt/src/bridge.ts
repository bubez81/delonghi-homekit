import mqtt, { type MqttClient } from 'mqtt';
import type { Machine } from './machine.js';
import { AUTO_OFF_OPTIONS, WATER_HARDNESS_OPTIONS, WATER_TEMPERATURE_OPTIONS, hex } from './protocol.js';
import type { Logger } from './transports/transport.js';

export interface MqttOptions {
  url: string;
  username?: string;
  password?: string;
  clientId?: string;
  baseTopic: string;
  haDiscovery: boolean;
  haDiscoveryPrefix: string;
}

/**
 * Topics (base = "delonghi"):
 *   <base>/bridge/state            online | offline (LWT, retained)
 *   <base>/<id>/availability       online | offline: BLE link to the machine (retained)
 *   <base>/<id>/state              JSON MachineState (retained)
 *   <base>/<id>/info               JSON static info: model, beverages, features (retained)
 *   <base>/<id>/event              JSON events: brew_started, brew_finished, error, raw frames
 *   <base>/<id>/set/<command>      commands, see README
 */
export class MqttBridge {
  private client?: MqttClient;
  private readonly machines = new Map<string, Machine>();
  private readonly lastProfiles = new Map<string, string>();

  constructor(
    private readonly opts: MqttOptions,
    private readonly log: Logger,
  ) {}

  add(machine: Machine): void {
    this.machines.set(machine.opts.id, machine);
    machine.on('state', () => this.publishState(machine));
  }

  private t(...parts: string[]): string {
    return [this.opts.baseTopic, ...parts].join('/');
  }

  async start(): Promise<void> {
    const client = mqtt.connect(this.opts.url, {
      username: this.opts.username || undefined,
      password: this.opts.password || undefined,
      clientId: this.opts.clientId ?? `delonghi2mqtt_${Math.random().toString(16).slice(2, 8)}`,
      will: { topic: this.t('bridge', 'state'), payload: Buffer.from('offline'), retain: true, qos: 1 },
      reconnectPeriod: 5_000,
    });
    this.client = client;

    client.on('connect', () => {
      this.log.info(`mqtt: connected to ${this.opts.url}`);
      client.publish(this.t('bridge', 'state'), 'online', { retain: true, qos: 1 });
      client.subscribe([this.t('+', 'set', '+'), this.t('+', 'set')]);
      if (this.opts.haDiscovery) client.subscribe(`${this.opts.haDiscoveryPrefix}/status`);
      for (const m of this.machines.values()) this.announce(m);
    });
    client.on('error', err => this.log.warn(`mqtt: ${err.message}`));
    client.on('offline', () => this.log.warn('mqtt: offline'));
    client.on('message', (topic, payload) => void this.onMessage(topic, payload.toString()));
  }

  async stop(): Promise<void> {
    const c = this.client;
    if (!c) return;
    for (const m of this.machines.values()) {
      c.publish(this.t(m.opts.id, 'availability'), 'offline', { retain: true });
    }
    await new Promise<void>(r => c.publish(this.t('bridge', 'state'), 'offline', { retain: true, qos: 1 }, () => r()));
    await c.endAsync();
  }

  private announce(m: Machine): void {
    this.publishInfo(m);
    this.publishState(m);
    if (this.opts.haDiscovery) this.publishDiscovery(m);
  }

  private publishInfo(m: Machine): void {
    const model = m.opts.model;
    const info = {
      id: m.opts.id,
      name: m.opts.name,
      model: model?.name ?? 'De\'Longhi coffee machine',
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
    this.client?.publish(this.t(m.opts.id, 'info'), JSON.stringify(info), { retain: true, qos: 1 });
  }

  private publishState(m: Machine): void {
    if (!this.client?.connected) return;
    // Profile names are read from the machine after connecting: refresh the
    // select options in Home Assistant when they change.
    const profiles = JSON.stringify(m.state.profiles);
    if (this.opts.haDiscovery && this.lastProfiles.get(m.opts.id) !== profiles) {
      const first = !this.lastProfiles.has(m.opts.id);
      this.lastProfiles.set(m.opts.id, profiles);
      if (!first) this.publishDiscovery(m);
    }
    this.client.publish(this.t(m.opts.id, 'availability'), m.state.connected ? 'online' : 'offline', {
      retain: true,
      qos: 1,
    });
    this.client.publish(this.t(m.opts.id, 'state'), JSON.stringify(m.state), { retain: true, qos: 1 });
  }

  event(m: Machine, type: string, data: Record<string, unknown> = {}): void {
    this.client?.publish(this.t(m.opts.id, 'event'), JSON.stringify({ type, ...data, at: new Date().toISOString() }));
  }

  private async onMessage(topic: string, payload: string): Promise<void> {
    if (topic === `${this.opts.haDiscoveryPrefix}/status`) {
      if (payload === 'online') for (const m of this.machines.values()) this.announce(m);
      return;
    }
    const parts = topic.split('/');
    const base = this.opts.baseTopic.split('/').length;
    const id = parts[base];
    const m = this.machines.get(id);
    if (!m || parts[base + 1] !== 'set') return;

    let command = parts[base + 2];
    let value = payload.trim();
    if (!command) {
      // <base>/<id>/set with JSON {"command": "...", "value": "..."}
      try {
        const j = JSON.parse(payload) as { command?: string; value?: unknown };
        command = j.command ?? '';
        value = j.value === undefined ? '' : String(j.value);
      } catch {
        this.log.warn(`mqtt: invalid JSON on ${topic}`);
        return;
      }
    }
    this.log.info(`[${id}] command ${command} ${value}`);
    const on = /^(on|true|1)$/i.test(value);

    try {
      switch (command) {
        case 'power':
          if (on) await m.powerOn();
          else await m.powerOff();
          break;
        case 'power_on':
          await m.powerOn();
          break;
        case 'power_off':
          await m.powerOff();
          break;
        case 'brew':
        case 'beverage':
          if (!value || value === 'none') await m.cancelBeverage();
          else {
            this.event(m, 'brew_requested', { beverage: value });
            await m.brewBeverage(value);
          }
          break;
        case 'cancel':
          await m.cancelBeverage();
          break;
        case 'profile':
          await m.selectProfile(value);
          break;
        case 'sounds':
        case 'energy_save':
        case 'cup_light':
          await m.setSwitchSetting(command, on);
          break;
        case 'auto_off':
          await m.setAutoOff(value);
          break;
        case 'water_hardness':
          await m.setWaterHardness(value);
          break;
        case 'water_temperature':
          await m.setWaterTemperature(value);
          break;
        case 'refresh':
          await m.readSettings();
          await m.refreshStatistics(true);
          break;
        case 'raw': {
          const reply = await m.sendRaw(value);
          this.event(m, 'raw_reply', { request: value, reply: reply ? hex(reply) : null });
          break;
        }
        default:
          this.log.warn(`[${id}] unknown command "${command}"`);
      }
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn(`[${id}] ${command} failed: ${message}`);
      this.event(m, 'error', { command, value, message });
    }
  }

  // ----------------------------------------------- Home Assistant discovery

  private publishDiscovery(m: Machine): void {
    const id = m.opts.id;
    const p = this.opts.haDiscoveryPrefix;
    const model = m.opts.model;
    const uid = (k: string) => `delonghi2mqtt_${id}_${k}`;
    const device = {
      identifiers: [`delonghi2mqtt_${id}`],
      name: m.opts.name,
      manufacturer: "De'Longhi",
      model: model?.name,
      model_id: model?.type,
    };
    const availability = {
      availability: [{ topic: this.t('bridge', 'state') }, { topic: this.t(id, 'availability') }],
      availability_mode: 'all',
    };
    const stateTopic = this.t(id, 'state');
    const base = (key: string, name: string | null, extra: Record<string, unknown>) => ({
      name,
      unique_id: uid(key),
      object_id: `${id}_${key}`,
      device,
      ...availability,
      ...extra,
    });
    const configs: Array<[string, string, Record<string, unknown>]> = [];
    const add = (component: string, key: string, cfg: Record<string, unknown>) => configs.push([component, key, cfg]);

    // Connectivity is available even when the machine link is down.
    add('binary_sensor', 'connected', {
      name: 'Connected',
      unique_id: uid('connected'),
      object_id: `${id}_connected`,
      device,
      availability_topic: this.t('bridge', 'state'),
      state_topic: this.t(id, 'availability'),
      payload_on: 'online',
      payload_off: 'offline',
      device_class: 'connectivity',
      entity_category: 'diagnostic',
    });

    const bs = (key: string, name: string, tpl: string, deviceClass: string, extra: Record<string, unknown> = {}) =>
      add(
        'binary_sensor',
        key,
        base(key, name, {
          state_topic: stateTopic,
          value_template: `{{ 'ON' if (${tpl}) else 'OFF' }}`,
          device_class: deviceClass,
          ...extra,
        }),
      );
    bs('power', 'Power', 'value_json.power', 'power');
    bs('dispensing', 'Dispensing', 'value_json.dispensing', 'running', {
      json_attributes_topic: stateTopic,
      json_attributes_template: '{{ {"progress": value_json.progress, "beverage": value_json.beverage} | tojson }}',
    });
    bs('water_tank', 'Water tank', 'value_json.problems.water_tank_empty or value_json.problems.water_tank_missing', 'problem');
    bs('grounds_container', 'Grounds container', 'value_json.problems.grounds_full or value_json.problems.grounds_missing', 'problem');
    bs('beans', 'Coffee beans', 'value_json.problems.beans_empty', 'problem');
    bs('descale', 'Descaling needed', 'value_json.problems.descale', 'problem');
    bs('filter', 'Water filter', 'value_json.problems.filter', 'problem');

    const sensor = (key: string, name: string, tpl: string, extra: Record<string, unknown> = {}) =>
      add('sensor', key, base(key, name, { state_topic: stateTopic, value_template: tpl, ...extra }));
    sensor('status', 'Status', '{{ value_json.status }}', {
      json_attributes_topic: stateTopic,
      json_attributes_template:
        '{{ {"machine_state": value_json.machine_state, "alarms": value_json.alarms, "sensors": value_json.sensors} | tojson }}',
      icon: 'mdi:coffee-maker',
    });
    sensor('nozzle', 'Nozzle', '{{ value_json.nozzle }}', { icon: 'mdi:coffee', entity_category: 'diagnostic' });
    sensor('progress', 'Progress', '{{ value_json.progress }}', { unit_of_measurement: '%', icon: 'mdi:progress-clock' });
    sensor('current_beverage', 'Current beverage', "{{ value_json.beverage or 'none' }}", { icon: 'mdi:coffee-to-go' });

    const stats: Array<[string, string, string, string?]> = [
      ['total_coffee', 'Total coffee', 'mdi:coffee'],
      ['total_coffee_with_milk', 'Total coffee with milk', 'mdi:coffee-outline'],
      ['total_water_l', 'Total water', 'mdi:water', 'L'],
      ['descaling_count', 'Descaling count', 'mdi:shimmer'],
      ['milk_cleaning_count', 'Milk cleaning count', 'mdi:water-sync'],
      ['filter_replacements', 'Filter replacements', 'mdi:filter'],
    ];
    for (const [key, name, icon, unit] of stats) {
      add(
        'sensor',
        key,
        base(key, name, {
          state_topic: stateTopic,
          value_template: `{{ value_json.stats.${key} if value_json.stats.${key} is defined else none }}`,
          state_class: 'total_increasing',
          icon,
          ...(unit ? { unit_of_measurement: unit, device_class: 'water' } : {}),
        }),
      );
    }

    add('button', 'power_on', base('power_on', 'Power on', { command_topic: this.t(id, 'set', 'power_on'), icon: 'mdi:power' }));
    if (m.opts.allowPowerOff) {
      add('button', 'power_off', base('power_off', 'Standby', { command_topic: this.t(id, 'set', 'power_off'), icon: 'mdi:power-standby' }));
    }
    add('button', 'cancel', base('cancel', 'Stop beverage', { command_topic: this.t(id, 'set', 'cancel'), icon: 'mdi:stop' }));
    add(
      'button',
      'refresh',
      base('refresh', 'Refresh', { command_topic: this.t(id, 'set', 'refresh'), entity_category: 'diagnostic' }),
    );

    add(
      'select',
      'beverage',
      base('beverage', 'Beverage', {
        command_topic: this.t(id, 'set', 'brew'),
        state_topic: stateTopic,
        value_template: "{{ value_json.beverage or 'none' }}",
        options: ['none', ...m.beverages],
        icon: 'mdi:coffee',
      }),
    );
    add(
      'select',
      'profile',
      base('profile', 'Profile', {
        command_topic: this.t(id, 'set', 'profile'),
        state_topic: stateTopic,
        value_template: '{{ value_json.profile }}',
        options: m.state.profiles,
        icon: 'mdi:account',
        entity_category: 'config',
      }),
    );
    const cfgSelect = (key: string, name: string, options: string[], icon: string) =>
      add(
        'select',
        key,
        base(key, name, {
          command_topic: this.t(id, 'set', key),
          state_topic: stateTopic,
          value_template: `{{ value_json.settings.${key} }}`,
          options,
          icon,
          entity_category: 'config',
        }),
      );
    if (model?.autoOff ?? true) cfgSelect('auto_off', 'Auto off', Object.keys(AUTO_OFF_OPTIONS), 'mdi:timer-off');
    if (model?.waterHardness ?? true) cfgSelect('water_hardness', 'Water hardness', WATER_HARDNESS_OPTIONS, 'mdi:water');
    cfgSelect('water_temperature', 'Water temperature', WATER_TEMPERATURE_OPTIONS, 'mdi:thermometer');

    const cfgSwitch = (key: string, name: string, icon: string) =>
      add(
        'switch',
        key,
        base(key, name, {
          command_topic: this.t(id, 'set', key),
          state_topic: stateTopic,
          value_template: `{{ 'ON' if value_json.settings.${key} else 'OFF' }}`,
          icon,
          entity_category: 'config',
        }),
      );
    if (model?.buzzer ?? true) cfgSwitch('sounds', 'Sounds', 'mdi:volume-high');
    if (model?.energySaving ?? true) cfgSwitch('energy_save', 'Energy saving', 'mdi:leaf');
    if (model?.cupLight) cfgSwitch('cup_light', 'Cup light', 'mdi:lightbulb');

    for (const [component, key, cfg] of configs) {
      this.client?.publish(`${p}/${component}/delonghi2mqtt_${id}/${key}/config`, JSON.stringify(cfg), {
        retain: true,
        qos: 1,
      });
    }
    this.log.info(`[${id}] published ${configs.length} Home Assistant discovery entities`);
  }
}
