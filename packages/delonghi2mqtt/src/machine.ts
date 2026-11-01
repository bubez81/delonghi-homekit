import { EventEmitter } from 'node:events';
import {
  AUTO_OFF_OPTIONS,
  CMD,
  COMMANDS,
  FrameAssembler,
  MACHINE_STATUS,
  type MonitorData,
  NOZZLE_STATE,
  type RecipeSpec,
  SETTING,
  SETTINGS_BITS,
  WATER_HARDNESS_OPTIONS,
  WATER_TEMPERATURE_OPTIONS,
  beverageStop,
  hex,
  isDispensing,
  parseHex,
  parseMonitor,
  parseProfileNames,
  parseSettingRead,
  parseStatistics,
  recipeStartCommand,
} from './protocol.js';
import type { MachineModel } from './models.js';
import type { BleTransport, Logger } from './transports/transport.js';

export interface MachineOptions {
  id: string;
  name: string;
  model?: MachineModel;
  recipes: RecipeSpec[];
  /** Standby command; not supported by every model. */
  allowPowerOff: boolean;
  /** Turn the machine on and wait until ready when a beverage is requested while off. */
  autoPowerOn: boolean;
  pollIntervalMs: number;
  statsIntervalMs: number;
}

export interface MachineState {
  connected: boolean;
  power: boolean | null;
  status: string;
  machine_state: string;
  state_code: number | null;
  alarms: string[];
  sensors: string[];
  problems: {
    water_tank_empty: boolean;
    water_tank_missing: boolean;
    grounds_full: boolean;
    grounds_missing: boolean;
    beans_empty: boolean;
    descale: boolean;
    filter: boolean;
  };
  dispensing: boolean;
  progress: number;
  /** Beverage requested by us that is pending or being dispensed. */
  beverage: string | null;
  /** "waiting_ready" while the machine heats before a queued beverage. */
  beverage_phase: 'idle' | 'waiting_ready' | 'starting' | 'dispensing';
  nozzle: string;
  profile: string | null;
  profiles: string[];
  settings: {
    sounds: boolean | null;
    energy_save: boolean | null;
    cup_light: boolean | null;
    auto_off: string | null;
    water_hardness: string | null;
    water_temperature: string | null;
  };
  stats: Record<string, number>;
  last_seen: string | null;
}

interface Pending {
  match: (f: Buffer) => boolean;
  resolve: (f: Buffer | undefined) => void;
  timer: NodeJS.Timeout;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const STAT_RANGES: Array<[number, number]> = [
  [100, 10],
  [110, 10],
  [3000, 10],
  [3017, 10],
  [3077, 4],
];

/**
 * Owns the single BLE connection to one machine. Emits:
 *  'state' (MachineState) whenever something changes
 *  'frame' (Buffer) for every valid frame received
 */
export class Machine extends EventEmitter {
  readonly state: MachineState;
  private readonly assembler = new FrameAssembler();
  private pending: Pending[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private running = false;
  private connecting?: Promise<void>;
  private pollTimer?: NodeJS.Timeout;
  private statsTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private fastPollTimer?: NodeJS.Timeout;
  private backoffMs = 5_000;
  private missedPolls = 0;
  private settingsRaw: number | null = null;
  private profileMap = new Map<number, string>();
  private brew?: { recipe: RecipeSpec; sawDispensing: boolean; startedAt: number; abort?: boolean };

  constructor(
    readonly opts: MachineOptions,
    private readonly transport: BleTransport,
    private readonly log: Logger,
  ) {
    super();
    const n = opts.model?.nProfiles ?? 4;
    for (let i = 1; i <= n; i++) this.profileMap.set(i, `Profile ${i}`);
    this.state = {
      connected: false,
      power: null,
      status: 'unknown',
      machine_state: 'unknown',
      state_code: null,
      alarms: [],
      sensors: [],
      problems: {
        water_tank_empty: false,
        water_tank_missing: false,
        grounds_full: false,
        grounds_missing: false,
        beans_empty: false,
        descale: false,
        filter: false,
      },
      dispensing: false,
      progress: 0,
      beverage: null,
      beverage_phase: 'idle',
      nozzle: 'unknown',
      profile: null,
      profiles: [...this.profileMap.values()],
      settings: {
        sounds: null,
        energy_save: null,
        cup_light: null,
        auto_off: null,
        water_hardness: null,
        water_temperature: null,
      },
      stats: {},
      last_seen: null,
    };

    transport.on('data', (chunk: Buffer) => {
      for (const f of this.assembler.push(chunk)) this.onFrame(f);
    });
    transport.on('disconnect', (reason: string) => this.onDisconnect(reason));
  }

  get beverages(): string[] {
    return this.opts.recipes.map(r => r.name);
  }

  // ------------------------------------------------------------ lifecycle

  start(): void {
    this.running = true;
    void this.ensureConnected();
  }

  async stop(): Promise<void> {
    this.running = false;
    clearInterval(this.pollTimer);
    clearInterval(this.statsTimer);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.fastPollTimer);
    await this.transport.close();
    this.setState({ connected: false });
  }

  private ensureConnected(): Promise<void> {
    if (this.transport.isConnected()) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.connectOnce().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private async connectOnce(): Promise<void> {
    clearTimeout(this.reconnectTimer);
    try {
      this.assembler.reset();
      await this.transport.connect();
    } catch (err) {
      this.log.warn(`[${this.opts.id}] connect failed via ${this.transport.name}: ${(err as Error).message}`);
      this.scheduleReconnect();
      throw err;
    }
    this.backoffMs = 5_000;
    this.missedPolls = 0;
    this.log.info(`[${this.opts.id}] connected via ${this.transport.name}`);
    this.setState({ connected: true });

    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.poll(), this.opts.pollIntervalMs);
    clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => void this.refreshStatistics(), this.opts.statsIntervalMs);

    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      await this.request(COMMANDS.statusPoll(), f => f[2] === CMD.MONITOR_V2 || f[2] === CMD.MONITOR_V1);
      await this.readSettings();
      const n = this.opts.model?.nProfiles ?? 4;
      await this.request(COMMANDS.profileNames(1, n), f => f[2] === CMD.PROFILE_NAMES);
      await this.refreshStatistics();
      // The machine sometimes ignores statistics requests right after connecting.
      if (Object.keys(this.state.stats).length === 0) {
        setTimeout(() => void this.refreshStatistics(), 30_000);
      }
    } catch (err) {
      this.log.warn(`[${this.opts.id}] initialization incomplete: ${(err as Error).message}`);
    }
  }

  private onDisconnect(reason: string): void {
    this.log.warn(`[${this.opts.id}] disconnected: ${reason}`);
    clearInterval(this.pollTimer);
    clearInterval(this.statsTimer);
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.resolve(undefined);
    }
    this.setState({ connected: false });
    this.scheduleReconnect(2_000);
  }

  private scheduleReconnect(delay?: number): void {
    if (!this.running) return;
    clearTimeout(this.reconnectTimer);
    const wait = delay ?? this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.reconnectTimer = setTimeout(() => void this.ensureConnected().catch(() => undefined), wait);
  }

  private async poll(): Promise<void> {
    const reply = await this.request(COMMANDS.statusPoll(), f => f[2] === CMD.MONITOR_V2 || f[2] === CMD.MONITOR_V1).catch(
      () => undefined,
    );
    if (reply) {
      this.missedPolls = 0;
      return;
    }
    if (++this.missedPolls >= 3) {
      this.log.warn(`[${this.opts.id}] no answer to 3 status polls, reconnecting`);
      this.missedPolls = 0;
      await this.transport.disconnect();
      this.onDisconnect('poll timeout');
    }
  }

  // ------------------------------------------------------------- requests

  /**
   * Send a frame (serialized with other requests). When `match` is given,
   * resolves with the first matching frame or undefined after the timeout.
   */
  request(frame: Buffer, match?: (f: Buffer) => boolean, timeoutMs = 5_000): Promise<Buffer | undefined> {
    const run = async () => {
      await this.ensureConnected();
      const wait = match
        ? new Promise<Buffer | undefined>(resolve => {
            const p: Pending = {
              match,
              resolve,
              timer: setTimeout(() => {
                this.pending = this.pending.filter(x => x !== p);
                this.log.debug(`[${this.opts.id}] no reply to ${hex(frame)}`);
                resolve(undefined);
              }, timeoutMs),
            };
            this.pending.push(p);
          })
        : Promise.resolve(undefined);
      this.log.debug(`[${this.opts.id}] >> ${hex(frame)}`);
      await this.transport.write(frame);
      return wait;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private onFrame(f: Buffer): void {
    this.log.debug(`[${this.opts.id}] << ${hex(f)}`);
    this.emit('frame', f);
    const now = new Date().toISOString();
    const cmd = f[2];

    if (cmd === CMD.MONITOR_V2 || cmd === CMD.MONITOR_V1) {
      const m = parseMonitor(f);
      if (m) this.applyMonitor(m);
    } else if (cmd === CMD.READ_SETTING) {
      const s = parseSettingRead(f);
      if (s && s.param === SETTING.SWITCHES) {
        this.settingsRaw = s.value;
        this.setState({
          settings: {
            ...this.state.settings,
            sounds: !!(s.value & SETTINGS_BITS.sounds),
            energy_save: !!(s.value & SETTINGS_BITS.energy_save),
            cup_light: !!(s.value & SETTINGS_BITS.cup_light),
          },
        });
      }
    } else if (cmd === CMD.PROFILE_NAMES) {
      const names = parseProfileNames(f, this.profileMap.size, f[4] || 1);
      for (const [id, name] of names) this.profileMap.set(id, name);
      this.setState({ profiles: [...this.profileMap.values()] });
    } else if (cmd === CMD.PROFILE_SELECT) {
      if (f[5] === 0) this.setState({ profile: this.profileMap.get(f[4]) ?? `Profile ${f[4]}` });
      else this.log.warn(`[${this.opts.id}] machine rejected profile ${f[4]}`);
    } else if (cmd === CMD.STATISTICS) {
      this.applyStatistics(parseStatistics(f));
    }

    this.state.last_seen = now;
    const idx = this.pending.findIndex(p => p.match(f));
    if (idx >= 0) {
      const [p] = this.pending.splice(idx, 1);
      clearTimeout(p.timer);
      p.resolve(f);
    }
  }

  private applyMonitor(m: MonitorData): void {
    const machineState = MACHINE_STATUS[m.status] ?? `state_${m.status}`;
    const dispensing = isDispensing(m);
    const has = (a: string) => m.alarms.includes(a);
    const sw = (s: string) => m.switches.includes(s);

    let beverage = this.state.beverage;
    let phase = this.state.beverage_phase;
    if (this.brew && phase !== 'waiting_ready') {
      if (dispensing) {
        this.brew.sawDispensing = true;
        phase = 'dispensing';
      } else if (this.brew.sawDispensing || Date.now() - this.brew.startedAt > 90_000) {
        this.log.info(
          `[${this.opts.id}] ${this.brew.recipe.name} ${this.brew.sawDispensing ? 'finished' : 'never started'}`,
        );
        this.brew = undefined;
        beverage = null;
        phase = 'idle';
        setTimeout(() => void this.refreshStatistics(true), 10_000);
      }
    }

    this.setState({
      power: m.status > 0,
      machine_state: machineState,
      state_code: m.status,
      status: m.alarms.length ? m.alarms[0] : machineState,
      alarms: m.alarms,
      sensors: m.switches,
      problems: {
        water_tank_empty: has('empty_water_tank') || sw('water_level_low'),
        water_tank_missing: sw('water_tank_absent'),
        grounds_full: has('coffee_waste_container_full'),
        grounds_missing: sw('coffee_waste_container'),
        beans_empty: has('coffee_beans_empty') || has('coffee_beans_empty_two'),
        descale: has('descale_alarm'),
        filter: has('replace_water_filter'),
      },
      dispensing,
      progress: dispensing ? m.percentage : 0,
      nozzle: m.nozzle === -1 ? this.state.nozzle : (NOZZLE_STATE[m.nozzle] ?? 'unknown'),
      beverage,
      beverage_phase: phase,
    });
  }

  private applyStatistics(raw: Map<number, number>): void {
    const s = { ...this.state.stats };
    for (const [k, v] of raw) s[`p${k}`] = v;
    const g = (id: number) => s[`p${id}`];
    if (g(3000) !== undefined || g(3077) !== undefined) s.total_coffee = (g(3000) ?? 0) + (g(3077) ?? 0);
    if (g(3001) !== undefined || g(3003) !== undefined) s.total_coffee_with_milk = (g(3001) ?? 0) + (g(3003) ?? 0);
    if (g(106) !== undefined) s.total_water_l = Math.round((g(106) / 2000) * 100) / 100;
    if (g(105) !== undefined) s.descaling_count = g(105);
    if (g(108) !== undefined) s.filter_replacements = g(108);
    if (g(111) !== undefined) s.milk_cleaning_count = g(111);
    if (g(3017) !== undefined) s.total_cold_milk = g(3017);
    if (g(3021) !== undefined) s.total_choco = g(3021);
    if (g(3025) !== undefined) s.total_tea = g(3025);
    this.setState({ stats: s });
  }

  private setState(patch: Partial<MachineState>): void {
    const before = JSON.stringify(this.publicState());
    Object.assign(this.state, patch);
    const after = JSON.stringify(this.publicState());
    if (before !== after) this.emit('state', this.state);
  }

  /** State without fields that change on every frame. */
  private publicState() {
    const { last_seen: _ls, ...rest } = this.state;
    return rest;
  }

  // ------------------------------------------------------------- actions

  async readSettings(): Promise<void> {
    await this.request(COMMANDS.readSettings(), f => f[2] === CMD.READ_SETTING);
  }

  async refreshStatistics(force = false): Promise<void> {
    if (!force && !this.transport.isConnected()) return;
    for (const [start, count] of STAT_RANGES) {
      await this.request(
        COMMANDS.statistics(start, count),
        f => f[2] === CMD.STATISTICS && f.length >= 12 && ((f[4] << 8) | f[5]) >= start,
        4_000,
      );
      await sleep(300);
    }
  }

  async powerOn(): Promise<void> {
    this.log.info(`[${this.opts.id}] power on`);
    await this.request(COMMANDS.powerOn());
    setTimeout(() => void this.poll(), 2_000);
  }

  async powerOff(): Promise<void> {
    if (!this.opts.allowPowerOff) {
      throw new Error('power off is disabled for this machine (allowPowerOff: false)');
    }
    this.log.info(`[${this.opts.id}] standby`);
    await this.request(COMMANDS.powerOff());
    setTimeout(() => void this.poll(), 2_000);
  }

  findRecipe(name: string): RecipeSpec | undefined {
    const n = name.trim().toLowerCase();
    return this.opts.recipes.find(r => r.name.toLowerCase() === n || String(r.id) === n);
  }

  async brewBeverage(name: string): Promise<void> {
    const recipe = this.findRecipe(name);
    if (!recipe) throw new Error(`unknown beverage "${name}"`);
    if (this.brew) throw new Error(`already preparing ${this.brew.recipe.name}`);

    this.brew = { recipe, sawDispensing: false, startedAt: Date.now() };
    const brew = this.brew;

    try {
      if (this.state.power === false || this.state.machine_state !== 'ready') {
        if (!this.opts.autoPowerOn && this.state.power === false) throw new Error('machine is off');
        this.setState({ beverage: recipe.name, beverage_phase: 'waiting_ready' });
        if (this.state.power === false) await this.powerOn();
        await this.waitReady(240_000, () => !!brew.abort);
        if (brew.abort) return;
      }
      this.log.info(`[${this.opts.id}] brewing ${recipe.name} (recipe ${recipe.id})`);
      brew.startedAt = Date.now();
      this.setState({ beverage: recipe.name, beverage_phase: 'starting' });
      await this.request(recipeStartCommand(recipe));
      this.startFastPoll();
    } catch (err) {
      if (this.brew === brew) this.brew = undefined;
      this.setState({ beverage: null, beverage_phase: 'idle' });
      throw err;
    }
  }

  /**
   * The machine only reports its state when polled: poll every 2 s while a
   * beverage is pending so the end of dispensing is seen promptly.
   */
  private startFastPoll(): void {
    clearInterval(this.fastPollTimer);
    this.fastPollTimer = setInterval(() => {
      if (!this.brew || !this.transport.isConnected()) {
        clearInterval(this.fastPollTimer);
        this.fastPollTimer = undefined;
        return;
      }
      void this.poll();
    }, 2_000);
  }

  private async waitReady(timeoutMs: number, aborted: () => boolean): Promise<void> {
    const started = Date.now();
    // Give the machine time to leave "off" after the power command.
    while (Date.now() - started < timeoutMs) {
      if (aborted()) return;
      if (this.state.machine_state === 'ready' && !this.state.dispensing && this.state.alarms.length === 0) return;
      if (this.state.machine_state === 'ready' && this.state.alarms.length > 0) {
        throw new Error(`machine reports ${this.state.alarms.join(', ')}`);
      }
      await sleep(2_000);
      void this.poll();
    }
    throw new Error('machine did not become ready in time');
  }

  async cancelBeverage(): Promise<void> {
    const brew = this.brew;
    if (!brew) return;
    brew.abort = true;
    this.brew = undefined;
    this.log.info(`[${this.opts.id}] cancel ${brew.recipe.name}`);
    this.setState({ beverage: null, beverage_phase: 'idle' });
    if (brew.sawDispensing || Date.now() - brew.startedAt < 90_000) {
      await this.request(beverageStop(brew.recipe.id));
    }
  }

  async selectProfile(nameOrId: string): Promise<void> {
    let id = Number(nameOrId);
    if (!Number.isInteger(id)) {
      id = [...this.profileMap].find(([, n]) => n === nameOrId)?.[0] ?? NaN;
    }
    if (!this.profileMap.has(id)) throw new Error(`unknown profile "${nameOrId}"`);
    await this.request(COMMANDS.selectProfile(id), f => f[2] === CMD.PROFILE_SELECT);
  }

  async setSwitchSetting(key: keyof typeof SETTINGS_BITS, on: boolean): Promise<void> {
    if (this.settingsRaw === null) await this.readSettings();
    let raw = this.settingsRaw ?? 0x81;
    raw = on ? raw | SETTINGS_BITS[key] : raw & ~SETTINGS_BITS[key];
    await this.request(COMMANDS.writeSetting(SETTING.SWITCHES, raw), f => f[2] === CMD.WRITE_SETTING);
    this.settingsRaw = raw;
    this.setState({ settings: { ...this.state.settings, [key]: on } });
    await this.readSettings();
  }

  async setAutoOff(option: string): Promise<void> {
    const v = AUTO_OFF_OPTIONS[option];
    if (v === undefined) throw new Error(`auto_off must be one of ${Object.keys(AUTO_OFF_OPTIONS).join(', ')}`);
    await this.request(COMMANDS.writeSetting(SETTING.AUTO_OFF, v), f => f[2] === CMD.WRITE_SETTING);
    this.setState({ settings: { ...this.state.settings, auto_off: option } });
  }

  async setWaterHardness(option: string): Promise<void> {
    const v = WATER_HARDNESS_OPTIONS.indexOf(option);
    if (v < 0) throw new Error(`water_hardness must be one of ${WATER_HARDNESS_OPTIONS.join(', ')}`);
    await this.request(COMMANDS.writeSetting(SETTING.WATER_HARDNESS, v), f => f[2] === CMD.WRITE_SETTING);
    this.setState({ settings: { ...this.state.settings, water_hardness: option } });
  }

  async setWaterTemperature(option: string): Promise<void> {
    const v = WATER_TEMPERATURE_OPTIONS.indexOf(option);
    if (v < 0) throw new Error(`water_temperature must be one of ${WATER_TEMPERATURE_OPTIONS.join(', ')}`);
    await this.request(COMMANDS.writeSetting(SETTING.WATER_TEMPERATURE, v), f => f[2] === CMD.WRITE_SETTING);
    this.setState({ settings: { ...this.state.settings, water_temperature: option } });
  }

  /** Send a raw frame given as hex; the CRC is recomputed when `fixCrc`. */
  async sendRaw(text: string, fixCrc = true): Promise<Buffer | undefined> {
    const bytes = parseHex(text);
    if (fixCrc && bytes.length >= 4) {
      const { withCrc } = await import('./protocol.js');
      return this.request(withCrc(bytes), f => f[2] === bytes[2]);
    }
    return this.request(bytes, f => f[2] === bytes[2]);
  }
}
