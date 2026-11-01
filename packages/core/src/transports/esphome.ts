import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { CCCD_UUID, CONTROL_CHAR_UUID } from '../protocol.js';
import { type BleTransport, type Logger, type MachineTarget, macToNumber, withTimeout } from './transport.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Connection } = require('@2colors/esphome-native-api') as { Connection: any };

export interface EsphomeOptions {
  host: string;
  port?: number;
  /** API encryption key (base64), as in the proxy's YAML `api: encryption: key:` */
  encryptionKey?: string;
  password?: string;
}

interface GattDescriptor { uuid: string; handle: number; shortUuid?: number }
interface GattCharacteristic { uuid: string; handle: number; properties: number; shortUuid?: number; descriptorsList: GattDescriptor[] }
interface GattService { uuid: string; characteristicsList: GattCharacteristic[] }

const SHORT_BASE = '-0000-1000-8000-00805f9b34fb';
function uuidOf(x: { uuid: string; shortUuid?: number }): string {
  if (x.uuid && !/^0+-0+-0+-0+-0+$/.test(x.uuid)) return x.uuid.toLowerCase();
  if (x.shortUuid) return x.shortUuid.toString(16).padStart(8, '0') + SHORT_BASE;
  return x.uuid.toLowerCase();
}

// BLE characteristic property bits
const PROP_WRITE_NO_RESPONSE = 0x04;
const PROP_WRITE = 0x08;

/**
 * Uses an ESPHome `bluetooth_proxy` over its native API (port 6053).
 *
 * ESPHome serves Bluetooth to ONE API client at a time: the proxy used here
 * must not also be used by Home Assistant for Bluetooth (dedicate an ESP32
 * to the machine, or remove that proxy from HA's Bluetooth integration).
 */
export class EsphomeTransport extends EventEmitter implements BleTransport {
  readonly name: string;
  private conn: any;
  private connected = false;
  private handle?: number;
  private writeWithResponse = true;
  private readonly address: number;
  private addressType?: number;

  constructor(
    target: MachineTarget,
    private readonly opts: EsphomeOptions,
    private readonly log: Logger,
  ) {
    super();
    if (!target.address) throw new Error('esphome transport: machine address not known (discovery failed)');
    this.address = macToNumber(target.address);
    this.name = `esphome(${opts.host})`;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async api(): Promise<any> {
    if (this.conn?.connected && this.conn?.authorized) return this.conn;
    if (this.conn) this.dropApi();

    const conn = new Connection({
      host: this.opts.host,
      port: this.opts.port ?? 6053,
      encryptionKey: this.opts.encryptionKey ?? '',
      password: this.opts.password ?? '',
      clientInfo: 'delonghi2mqtt',
      reconnect: false,
    });
    this.conn = conn;

    conn.on('error', (e: Error) => this.log.debug(`esphome api error: ${e.message}`));
    conn.frameHelper.on('close', () => {
      if (this.conn !== conn) return;
      this.log.warn(`esphome: API connection to ${this.opts.host} closed`);
      this.conn = undefined;
      this.markDisconnected('esphome API closed');
    });
    conn.on('message.BluetoothDeviceConnectionResponse', (m: any) => {
      if (m.address === this.address && !m.connected && this.connected) {
        this.markDisconnected(`proxy reports BLE disconnect (error ${m.error})`);
      }
    });
    conn.on('message.BluetoothGATTNotifyDataResponse', (m: any) => {
      if (m.address === this.address && m.handle === this.handle) {
        this.emit('data', Buffer.from(m.data, 'base64'));
      }
    });
    conn.on('message.BluetoothGATTErrorResponse', (m: any) => {
      if (m.address === this.address) this.log.warn(`esphome: GATT error ${m.error} on handle ${m.handle}`);
    });
    conn.on('message.BluetoothLEAdvertisementResponse', (m: any) => {
      if (m.address === this.address) {
        if (this.addressType === undefined) this.log.debug(`esphome: machine seen, rssi ${m.rssi}`);
        this.addressType = m.addressType ?? 0;
        this.emit('advertisement', m);
      }
    });

    conn.connect();
    const started = Date.now();
    while (!(conn.connected && conn.authorized)) {
      if (Date.now() - started > 15_000) {
        this.dropApi();
        throw new Error(`cannot reach ESPHome API at ${this.opts.host}`);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    this.log.info(`esphome: API connected to ${this.opts.host}`);
    conn.subscribeBluetoothAdvertisementService();
    return conn;
  }

  private dropApi(): void {
    const c = this.conn;
    this.conn = undefined;
    try {
      c?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      c?.frameHelper?.destroy?.();
    } catch {
      /* ignore */
    }
  }

  private waitForAdvertisement(ms: number): Promise<void> {
    if (this.addressType !== undefined) return Promise.resolve();
    return withTimeout(
      new Promise<void>(resolve => this.once('advertisement', () => resolve())),
      ms,
      'machine advertisement via proxy (not in range, already connected to someone else, or the proxy is claimed by Home Assistant)',
    );
  }

  private markDisconnected(reason: string): void {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnect', reason);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const conn = await this.api();
    await this.waitForAdvertisement(30_000);

    this.log.info(`esphome: connecting to machine via ${this.opts.host}`);
    const res = await conn.connectBluetoothDeviceService(this.address, this.addressType);
    if (!res.connected) {
      throw new Error(`proxy failed to connect to machine (error ${res.error})`);
    }

    try {
      const { servicesList } = (await conn.listBluetoothGATTServicesService(this.address)) as {
        servicesList: GattService[];
      };
      let ch: GattCharacteristic | undefined;
      for (const s of servicesList) {
        ch = s.characteristicsList.find(c => uuidOf(c) === CONTROL_CHAR_UUID);
        if (ch) break;
      }
      if (!ch) throw new Error('control characteristic not found in GATT table');
      this.handle = ch.handle;
      this.writeWithResponse = (ch.properties & PROP_WRITE) !== 0 || (ch.properties & PROP_WRITE_NO_RESPONSE) === 0;

      await conn.notifyBluetoothGATTCharacteristicService(this.address, ch.handle);
      // Like bleak-esphome: enable notifications on the peer explicitly.
      const cccd = ch.descriptorsList.find(d => uuidOf(d) === CCCD_UUID);
      if (cccd) {
        await conn.writeBluetoothGATTDescriptorService(this.address, cccd.handle, Uint8Array.from([0x01, 0x00]));
      }
    } catch (err) {
      await conn.disconnectBluetoothDeviceService(this.address).catch(() => undefined);
      throw err;
    }
    this.connected = true;
    this.log.info(`esphome: connected, control handle ${this.handle}`);
  }

  async write(data: Buffer): Promise<void> {
    if (!this.connected || this.handle === undefined || !this.conn) throw new Error('not connected');
    if (this.writeWithResponse) {
      await this.conn.writeBluetoothGATTCharacteristicService(this.address, this.handle, Uint8Array.from(data), true);
    } else {
      // No acknowledgement is sent for write-without-response.
      this.conn.sendMessage(
        new (require('@2colors/esphome-native-api/lib/utils/messages').pb.BluetoothGATTWriteRequest)([
          this.address,
          this.handle,
          false,
          Uint8Array.from(data),
        ]),
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this.conn && this.connected) {
      await withTimeout(this.conn.disconnectBluetoothDeviceService(this.address), 5_000, 'disconnect').catch(
        () => undefined,
      );
    }
    this.connected = false;
  }

  async close(): Promise<void> {
    await this.disconnect();
    this.dropApi();
  }
}
