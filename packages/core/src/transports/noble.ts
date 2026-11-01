import { EventEmitter } from 'node:events';
import { CONTROL_CHAR_UUID, SERVICE_UUID } from '../protocol.js';
import { type BleTransport, type Logger, type MachineTarget, normalizeMac, withTimeout } from './transport.js';

// Loaded lazily so the ESPHome transport works on hosts without BLE bindings.
type Noble = import('@stoprocent/noble').Noble;
type Peripheral = import('@stoprocent/noble').Peripheral;
type Characteristic = import('@stoprocent/noble').Characteristic;

const short = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();

let nobleInstance: Noble | undefined;
async function getNoble(): Promise<Noble> {
  if (!nobleInstance) {
    const mod = await import('@stoprocent/noble');
    nobleInstance = (mod.default ?? mod) as unknown as Noble;
  }
  return nobleInstance;
}

export interface NobleOptions {
  scanTimeoutMs?: number;
}

/**
 * Local Bluetooth adapter (CoreBluetooth on macOS, HCI on Linux).
 * On macOS the MAC address is hidden by the OS, so the machine is matched by
 * its advertised name (bleName) or, failing that, by the service UUID.
 */
export class NobleTransport extends EventEmitter implements BleTransport {
  readonly name = 'noble';
  private peripheral?: Peripheral;
  private characteristic?: Characteristic;
  private connected = false;

  constructor(
    private readonly target: MachineTarget,
    private readonly log: Logger,
    private readonly opts: NobleOptions = {},
  ) {
    super();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private matches(p: Peripheral): boolean {
    const name = p.advertisement?.localName ?? '';
    if (this.target.address && p.address && normalizeMac(p.address) === normalizeMac(this.target.address)) {
      return true;
    }
    if (this.target.bleName && name === this.target.bleName) return true;
    if (!this.target.bleName && !(this.target.address && p.address)) {
      return (p.advertisement?.serviceUuids ?? []).map(short).includes(short(SERVICE_UUID));
    }
    return false;
  }

  private async find(noble: Noble): Promise<Peripheral> {
    const timeout = this.opts.scanTimeoutMs ?? 30_000;
    return new Promise<Peripheral>((resolve, reject) => {
      const onDiscover = (p: Peripheral) => {
        if (!this.matches(p)) return;
        cleanup();
        noble.stopScanningAsync().catch(() => undefined);
        resolve(p);
      };
      const timer = setTimeout(() => {
        cleanup();
        noble.stopScanningAsync().catch(() => undefined);
        reject(new Error('machine not found while scanning (is it in range, and is the official app disconnected?)'));
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        noble.removeListener('discover', onDiscover);
      };
      noble.on('discover', onDiscover);
      noble.startScanningAsync([], true).catch(err => {
        cleanup();
        reject(err);
      });
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const noble = await getNoble();
    await noble.waitForPoweredOnAsync(15_000);

    const p = this.peripheral && this.peripheral.state !== 'error' ? this.peripheral : await this.find(noble);
    this.peripheral = p;
    this.log.info(`noble: connecting to ${p.advertisement?.localName ?? p.id} (${p.address || p.id})`);
    await withTimeout(p.connectAsync(), 20_000, 'BLE connect');

    try {
      const { characteristics } = await withTimeout(
        p.discoverSomeServicesAndCharacteristicsAsync([short(SERVICE_UUID)], [short(CONTROL_CHAR_UUID)]),
        15_000,
        'GATT discovery',
      );
      const ch = characteristics.find(c => short(c.uuid) === short(CONTROL_CHAR_UUID));
      if (!ch) throw new Error('control characteristic not found');
      ch.on('data', (data: Buffer) => this.emit('data', data));
      await withTimeout(ch.subscribeAsync(), 10_000, 'subscribe');
      this.characteristic = ch;
    } catch (err) {
      await p.disconnectAsync().catch(() => undefined);
      throw err;
    }

    p.once('disconnect', reason => {
      this.connected = false;
      this.characteristic?.removeAllListeners('data');
      this.characteristic = undefined;
      this.emit('disconnect', `noble disconnect (${String(reason)})`);
    });
    this.connected = true;
  }

  async write(data: Buffer): Promise<void> {
    if (!this.characteristic || !this.connected) throw new Error('not connected');
    const withoutResponse = !this.characteristic.properties.includes('write');
    await withTimeout(this.characteristic.writeAsync(data, withoutResponse), 10_000, 'GATT write');
  }

  async disconnect(): Promise<void> {
    const p = this.peripheral;
    if (p && this.connected) {
      await withTimeout(p.disconnectAsync(), 5_000, 'BLE disconnect').catch(() => undefined);
    }
    this.connected = false;
  }

  async close(): Promise<void> {
    await this.disconnect();
  }
}
