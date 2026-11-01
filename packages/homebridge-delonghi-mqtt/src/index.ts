import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  WithUUID,
} from 'homebridge';
import mqtt, { type MqttClient } from 'mqtt';

const PLUGIN_NAME = 'homebridge-delonghi-mqtt';
const PLATFORM_NAME = 'DelonghiMqtt';

/** Italian defaults for the catalog beverage names; override with `beverageNames`. */
const DEFAULT_BEVERAGE_NAMES: Record<string, string> = {
  'Espresso Coffee': 'Espresso',
  'Regular Coffee': 'Caffè',
  'Long Coffee': 'Caffè lungo',
  '2X Espresso Coffee': 'Doppio espresso',
  'Doppio+': 'Doppio+',
  Americano: 'Americano',
  Cappuccino: 'Cappuccino',
  'Latte Macchiato': 'Latte macchiato',
  'Caffé Latte': 'Caffellatte',
  'Flat White': 'Flat white',
  'Espresso Macchiato': 'Caffè macchiato',
  'Hot Milk': 'Latte caldo',
  'Cappuccino Doppio+': 'Cappuccino doppio',
  'Cappuccino Reverse': 'Cappuccino mix',
  'Hot Water': 'Acqua calda',
};

interface MachineConfig {
  id: string;
  name?: string;
  /** Beverages exposed as switches (catalog names). Default: a few common ones. */
  beverages?: string[];
  beverageNames?: Record<string, string>;
  /** Expose water tank / grounds / beans / descale / filter sensors. Default true. */
  sensors?: boolean;
}

interface DelonghiConfig extends PlatformConfig {
  mqttUrl: string;
  username?: string;
  password?: string;
  baseTopic?: string;
  machines?: MachineConfig[];
}

interface MachineInfo {
  id: string;
  name: string;
  model: string;
  product_code: string | null;
  beverages: string[];
  features: { power_off: boolean };
}

interface MachineState {
  connected: boolean;
  power: boolean | null;
  status: string;
  dispensing: boolean;
  progress: number;
  beverage: string | null;
  problems: Record<
    'water_tank_empty' | 'water_tank_missing' | 'grounds_full' | 'grounds_missing' | 'beans_empty' | 'descale' | 'filter',
    boolean
  >;
}

const DEFAULT_BEVERAGES = ['Espresso Coffee', 'Regular Coffee', 'Long Coffee', 'Cappuccino', 'Latte Macchiato'];

export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, DelonghiPlatform);
};

class DelonghiPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly machines = new Map<string, MachineHandler>();
  private client?: MqttClient;
  private readonly base: string;
  private bridgeOnline = true;

  constructor(
    readonly log: Logging,
    readonly config: DelonghiConfig,
    readonly api: API,
  ) {
    this.base = config.baseTopic ?? 'delonghi';
    if (!config.mqttUrl) {
      log.error('mqttUrl is required');
      return;
    }
    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => void this.client?.endAsync());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  takeCached(uuid: string): PlatformAccessory | undefined {
    const a = this.cached.get(uuid);
    this.cached.delete(uuid);
    return a;
  }

  publish(id: string, command: string, value: string): void {
    this.client?.publish(`${this.base}/${id}/set/${command}`, value);
  }

  isBridgeOnline(): boolean {
    return this.bridgeOnline;
  }

  private start(): void {
    const client = mqtt.connect(this.config.mqttUrl, {
      username: this.config.username || undefined,
      password: this.config.password || undefined,
      clientId: `homebridge-delonghi_${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 5_000,
    });
    this.client = client;
    client.on('connect', () => {
      this.log.info(`MQTT connected to ${this.config.mqttUrl}`);
      client.subscribe([`${this.base}/bridge/state`, `${this.base}/+/info`, `${this.base}/+/state`, `${this.base}/+/event`]);
    });
    client.on('error', e => this.log.warn(`MQTT: ${e.message}`));
    client.on('message', (topic, payload) => this.onMessage(topic, payload.toString()));

    // Drop cached accessories nobody claimed once the retained info had time to arrive.
    setTimeout(() => {
      if (this.cached.size === 0) return;
      const stale = [...this.cached.values()];
      this.log.info(`removing ${stale.length} stale accessories`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.cached.clear();
    }, 30_000);
  }

  private onMessage(topic: string, payload: string): void {
    const rest = topic.slice(this.base.length + 1).split('/');
    const [id, kind] = rest;
    if (id === 'bridge' && kind === 'state') {
      this.bridgeOnline = payload === 'online';
      for (const m of this.machines.values()) m.refresh();
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    if (kind === 'info') {
      const info = data as MachineInfo;
      const cfg = this.machineConfig(id);
      if (!cfg) return;
      let handler = this.machines.get(id);
      if (!handler) {
        handler = new MachineHandler(this, cfg, info);
        this.machines.set(id, handler);
      } else {
        handler.updateInfo(info);
      }
    } else if (kind === 'state') {
      this.machines.get(id)?.updateState(data as MachineState);
    } else if (kind === 'event') {
      const ev = data as { type: string; message?: string; command?: string };
      if (ev.type === 'error') this.log.warn(`[${id}] ${ev.command}: ${ev.message}`);
    }
  }

  /** Configured machine, or auto-added when no machines are configured. */
  private machineConfig(id: string): MachineConfig | undefined {
    const list = this.config.machines ?? [];
    if (list.length === 0) return { id };
    return list.find(m => m.id === id);
  }
}

type Sensor = { service: Service; problem: (s: MachineState) => boolean };

/**
 * One accessory per machine: power switch (primary), one switch per
 * beverage, "dispensing" occupancy sensor and contact sensors that open when
 * the machine needs attention (so Home can notify and automate on them).
 */
class MachineHandler {
  private state?: MachineState;
  private readonly acc: PlatformAccessory;
  private readonly powerService: Service;
  private readonly dispensingService: Service;
  private readonly sensors: Sensor[] = [];
  private readonly beverageServices = new Map<string, Service>();
  private readonly C;
  private readonly S;

  constructor(
    private readonly platform: DelonghiPlatform,
    private readonly cfg: MachineConfig,
    private info: MachineInfo,
  ) {
    const { api } = platform;
    this.C = api.hap.Characteristic;
    this.S = api.hap.Service;
    const name = cfg.name ?? info.name;

    const uuid = api.hap.uuid.generate(`delonghi:${cfg.id}:main`);
    let acc = platform.takeCached(uuid);
    const isNew = !acc;
    acc ??= new api.platformAccessory(name, uuid, api.hap.Categories.SWITCH);
    this.acc = acc;
    acc.getService(this.S.AccessoryInformation)!
      .setCharacteristic(this.C.Manufacturer, "De'Longhi")
      .setCharacteristic(this.C.Model, info.model)
      .setCharacteristic(this.C.SerialNumber, info.product_code ?? cfg.id);

    this.powerService = this.service(this.S.Switch, 'power', name);
    this.powerService
      .getCharacteristic(this.C.On)
      .onGet(() => this.read(s => !!s.power))
      .onSet(v => this.setPower(!!v));
    this.powerService.setPrimaryService(true);

    this.dispensingService = this.service(this.S.OccupancySensor, 'dispensing', 'In erogazione');
    this.dispensingService
      .getCharacteristic(this.C.OccupancyDetected)
      .onGet(() => this.read(s => (s.dispensing ? 1 : 0)));

    if (cfg.sensors !== false) {
      const contact = (sub: string, label: string, problem: (s: MachineState) => boolean) => {
        const svc = this.service(this.S.ContactSensor, sub, label);
        svc.getCharacteristic(this.C.ContactSensorState).onGet(() => this.read(s => (problem(s) ? 1 : 0)));
        this.sensors.push({ service: svc, problem });
      };
      contact('water', 'Serbatoio acqua', s => s.problems.water_tank_empty || s.problems.water_tank_missing);
      contact('grounds', 'Contenitore fondi', s => s.problems.grounds_full || s.problems.grounds_missing);
      contact('beans', 'Chicchi caffè', s => s.problems.beans_empty);
      contact('descale_alert', 'Decalcificazione', s => s.problems.descale);
      contact('filter_alert', 'Filtro acqua', s => s.problems.filter);
    }

    this.syncBeverages(false);
    this.removeUnusedServices();

    if (isNew) api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    else api.updatePlatformAccessories([acc]);
    platform.log.info(`[${cfg.id}] ${info.model}: ${this.beverageServices.size} beverages exposed`);
  }

  private service(type: WithUUID<typeof Service>, subtype: string, name: string): Service {
    const svc = this.acc.getServiceById(type, subtype) ?? this.acc.addService(type, name, subtype);
    svc.setCharacteristic(this.C.Name, name);
    if (!svc.testCharacteristic(this.C.ConfiguredName)) svc.addOptionalCharacteristic(this.C.ConfiguredName);
    if (!svc.getCharacteristic(this.C.ConfiguredName).value) svc.setCharacteristic(this.C.ConfiguredName, name);
    return svc;
  }

  /** Drop services left over from older layouts or removed beverages. */
  private removeUnusedServices(): void {
    const used = new Set<Service>([
      this.powerService,
      this.dispensingService,
      ...this.sensors.map(s => s.service),
      ...this.beverageServices.values(),
    ]);
    for (const svc of [...this.acc.services]) {
      if (svc.UUID === this.S.AccessoryInformation.UUID || used.has(svc)) continue;
      this.acc.removeService(svc);
    }
  }

  private wantedBeverages(): string[] {
    const wanted = this.cfg.beverages?.length ? this.cfg.beverages : DEFAULT_BEVERAGES;
    const available = new Set(this.info.beverages);
    for (const b of wanted) {
      if (!available.has(b)) this.platform.log.warn(`[${this.cfg.id}] beverage "${b}" not offered by this machine`);
    }
    return wanted.filter(b => available.has(b));
  }

  private syncBeverages(cleanup = true): void {
    const wanted = this.wantedBeverages();
    for (const bev of wanted) {
      if (this.beverageServices.has(bev)) continue;
      const label = this.cfg.beverageNames?.[bev] ?? DEFAULT_BEVERAGE_NAMES[bev] ?? bev;
      const svc = this.service(this.S.Switch, `bev:${bev}`, label);
      svc
        .getCharacteristic(this.C.On)
        .onGet(() => this.read(s => s.beverage === bev))
        .onSet(v => this.setBeverage(bev, !!v));
      this.beverageServices.set(bev, svc);
    }
    for (const bev of [...this.beverageServices.keys()]) {
      if (!wanted.includes(bev)) this.beverageServices.delete(bev);
    }
    if (cleanup) {
      this.removeUnusedServices();
      this.platform.api.updatePlatformAccessories([this.acc]);
    }
  }

  updateInfo(info: MachineInfo): void {
    this.info = info;
    this.syncBeverages();
  }

  private reachable(): boolean {
    return this.platform.isBridgeOnline() && !!this.state?.connected;
  }

  private commError() {
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  /** Read from the cached state; "No Response" in Home when the machine is unreachable. */
  private read<T>(fn: (s: MachineState) => T): T {
    if (!this.state || !this.reachable()) throw this.commError();
    return fn(this.state);
  }

  private setPower(on: boolean): void {
    if (!this.reachable()) throw this.commError();
    if (on) {
      this.platform.publish(this.cfg.id, 'power_on', '');
    } else if (this.info.features.power_off) {
      this.platform.publish(this.cfg.id, 'power_off', '');
    } else {
      this.platform.log.info(`[${this.cfg.id}] standby is not supported by this machine, ignoring "off"`);
      setTimeout(() => this.refresh(), 500);
    }
  }

  private setBeverage(bev: string, on: boolean): void {
    if (!this.reachable()) throw this.commError();
    if (on) {
      if (this.state?.beverage && this.state.beverage !== bev) {
        this.platform.log.warn(`[${this.cfg.id}] busy with ${this.state.beverage}, ignoring ${bev}`);
        setTimeout(() => this.refresh(), 500);
        return;
      }
      this.platform.log.info(`[${this.cfg.id}] brew ${bev}`);
      this.platform.publish(this.cfg.id, 'brew', bev);
    } else if (this.state?.beverage === bev) {
      this.platform.log.info(`[${this.cfg.id}] cancel ${bev}`);
      this.platform.publish(this.cfg.id, 'cancel', '');
    }
  }

  updateState(state: MachineState): void {
    this.state = state;
    this.refresh();
  }

  /** Push the cached state (or "No Response") to every characteristic. */
  refresh(): void {
    const s = this.state;
    const ok = !!s && this.reachable();
    const upd = (svc: Service, ch: WithUUID<new () => Characteristic>, value: () => boolean | number) => {
      if (ok) svc.updateCharacteristic(ch, value());
      else svc.updateCharacteristic(ch, this.commError());
    };
    upd(this.powerService, this.C.On, () => !!s!.power);
    upd(this.dispensingService, this.C.OccupancyDetected, () => (s!.dispensing ? 1 : 0));
    for (const { service, problem } of this.sensors) {
      upd(service, this.C.ContactSensorState, () => (problem(s!) ? 1 : 0));
    }
    for (const [bev, svc] of this.beverageServices) upd(svc, this.C.On, () => s!.beverage === bev);
  }
}
