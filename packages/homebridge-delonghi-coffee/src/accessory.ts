import type { Characteristic, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { MachineInfo, MachineState } from 'delonghi-core';
import type { DelonghiPlatform } from './platform.js';

/** Where an accessory gets its data from and sends commands to. */
export interface MachineLink {
  info: MachineInfo;
  state?: MachineState;
  /** True while the machine can be reached. */
  online(): boolean;
  send(command: string, value?: string): void;
}

export interface AccessoryOptions {
  /** Beverages exposed as switches (catalog names). */
  beverages?: string[];
  beverageNames?: Record<string, string>;
  /** Contact sensors for water/grounds/beans/descaling/filter. Default true. */
  sensors?: boolean;
}

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

const DEFAULT_BEVERAGES = ['Espresso Coffee', 'Regular Coffee', 'Long Coffee', 'Cappuccino', 'Latte Macchiato'];

type Sensor = { service: Service; problem: (s: MachineState) => boolean };

/**
 * One accessory per machine: power switch (primary), one switch per
 * beverage, "dispensing" occupancy sensor and contact sensors that open when
 * the machine needs attention (so Home can notify and automate on them).
 */
export class CoffeeAccessory {
  readonly acc: PlatformAccessory;
  private readonly powerService: Service;
  private readonly dispensingService: Service;
  private readonly sensors: Sensor[] = [];
  private readonly beverageServices = new Map<string, Service>();
  private readonly C;
  private readonly S;

  constructor(
    private readonly platform: DelonghiPlatform,
    private readonly key: string,
    private readonly displayName: string,
    private readonly opts: AccessoryOptions,
    private readonly link: MachineLink,
  ) {
    const { api } = platform;
    this.C = api.hap.Characteristic;
    this.S = api.hap.Service;
    const info = link.info;

    const uuid = api.hap.uuid.generate(`delonghi:${key}:main`);
    let acc = platform.takeCached(uuid);
    const isNew = !acc;
    acc ??= new api.platformAccessory(displayName, uuid, api.hap.Categories.SWITCH);
    this.acc = acc;
    acc.getService(this.S.AccessoryInformation)!
      .setCharacteristic(this.C.Manufacturer, "De'Longhi")
      .setCharacteristic(this.C.Model, info.model)
      .setCharacteristic(this.C.SerialNumber, info.product_code ?? key);

    this.powerService = this.service(this.S.Switch, 'power', displayName);
    this.powerService
      .getCharacteristic(this.C.On)
      .onGet(() => this.read(s => !!s.power))
      .onSet(v => this.setPower(!!v));
    this.powerService.setPrimaryService(true);

    this.dispensingService = this.service(this.S.OccupancySensor, 'dispensing', 'In erogazione');
    this.dispensingService
      .getCharacteristic(this.C.OccupancyDetected)
      .onGet(() => this.read(s => (s.dispensing ? 1 : 0)));

    if (opts.sensors !== false) {
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

    if (isNew) platform.registerAccessory(acc);
    else api.updatePlatformAccessories([acc]);
    platform.log.info(`[${key}] ${info.model}: ${this.beverageServices.size} beverages exposed`);
    this.refresh();
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
    const wanted = this.opts.beverages?.length ? this.opts.beverages : DEFAULT_BEVERAGES;
    const available = new Set(this.link.info.beverages);
    for (const b of wanted) {
      if (!available.has(b)) {
        this.platform.log.warn(
          `[${this.key}] beverage "${b}" not offered by this machine. Available: ${[...available].join(', ')}`,
        );
      }
    }
    return wanted.filter(b => available.has(b));
  }

  private syncBeverages(cleanup = true): void {
    const wanted = this.wantedBeverages();
    for (const bev of wanted) {
      if (this.beverageServices.has(bev)) continue;
      const label = this.opts.beverageNames?.[bev] ?? DEFAULT_BEVERAGE_NAMES[bev] ?? bev;
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

  /** Call when link.info changed (e.g. a new info message from the bridge). */
  infoChanged(): void {
    this.syncBeverages();
  }

  private commError() {
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private reachable(): boolean {
    return !!this.link.state && this.link.online();
  }

  /** Read from the cached state; "No Response" in Home when the machine is unreachable. */
  private read<T>(fn: (s: MachineState) => T): T {
    if (!this.reachable()) throw this.commError();
    return fn(this.link.state!);
  }

  private setPower(on: boolean): void {
    if (!this.reachable()) throw this.commError();
    if (on) {
      this.link.send('power_on');
    } else if (this.link.info.features.power_off) {
      this.link.send('power_off');
    } else {
      this.platform.log.info(`[${this.key}] standby is not supported by this machine, ignoring "off"`);
      setTimeout(() => this.refresh(), 500);
    }
  }

  private setBeverage(bev: string, on: boolean): void {
    if (!this.reachable()) throw this.commError();
    const current = this.link.state?.beverage;
    if (on) {
      if (current && current !== bev) {
        this.platform.log.warn(`[${this.key}] busy with ${current}, ignoring ${bev}`);
        setTimeout(() => this.refresh(), 500);
        return;
      }
      this.platform.log.info(`[${this.key}] brew ${bev}`);
      this.link.send('brew', bev);
    } else if (current === bev) {
      this.platform.log.info(`[${this.key}] cancel ${bev}`);
      this.link.send('cancel');
    }
  }

  /** Push the cached state (or "No Response") to every characteristic. */
  refresh(): void {
    const s = this.link.state;
    const ok = this.reachable();
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
