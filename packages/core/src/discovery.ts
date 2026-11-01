import { createRequire } from 'node:module';
import { guessModel } from './models.js';
import { SERVICE_UUID } from './protocol.js';
import type { EsphomeOptions } from './transports/esphome.js';
import { numberToMac } from './transports/transport.js';

export interface FoundMachine {
  /** MAC address; empty on macOS, where the OS hides it. */
  address: string;
  /** CoreBluetooth peripheral id (macOS only). */
  id?: string;
  bleName: string;
  rssi: number;
  productCode?: string;
  model?: string;
}

const NAME_RE = /^D\d{6,}$/;
const short = (u: string) => u.replace(/-/g, '').toLowerCase();

function isDelonghi(name: string, uuids: string[]): boolean {
  return NAME_RE.test(name) || uuids.map(short).includes(short(SERVICE_UUID));
}

function withModel(m: FoundMachine): FoundMachine {
  const model = guessModel(m.bleName);
  return model ? { ...m, productCode: model.productCode, model: model.name } : m;
}

function upsert(found: Map<string, FoundMachine>, key: string, m: FoundMachine, onFound?: (m: FoundMachine) => void) {
  const prev = found.get(key);
  const next = withModel({ ...m, bleName: m.bleName || prev?.bleName || '' });
  found.set(key, next);
  if (!prev) onFound?.(next);
}

/**
 * Listen for De'Longhi machines. A machine only advertises while nobody is
 * connected to it, so close the official app / other integrations first.
 */
export async function discoverEsphome(
  opts: EsphomeOptions,
  seconds: number,
  onFound?: (m: FoundMachine) => void,
  stopOnFirst = false,
): Promise<FoundMachine[]> {
  const { Connection } = createRequire(import.meta.url)('@2colors/esphome-native-api');
  const conn = new Connection({
    host: opts.host,
    port: opts.port ?? 6053,
    encryptionKey: opts.encryptionKey ?? '',
    password: opts.password ?? '',
    reconnect: false,
    clientInfo: 'delonghi2mqtt discovery',
  });
  const found = new Map<string, FoundMachine>();
  let done: () => void = () => undefined;
  const finished = new Promise<void>(r => (done = r));
  conn.on('error', () => undefined);
  conn.on('message.BluetoothLEAdvertisementResponse', (a: any) => {
    const name: string = a.name ?? '';
    if (!isDelonghi(name, a.serviceUuidsList ?? [])) return;
    upsert(found, String(a.address), { address: numberToMac(a.address), bleName: name, rssi: a.rssi }, onFound);
    if (stopOnFirst && found.get(String(a.address))?.bleName) done();
  });
  conn.connect();
  const t0 = Date.now();
  while (!(conn.connected && conn.authorized)) {
    if (Date.now() - t0 > 15_000) {
      try {
        conn.disconnect();
      } catch {
        /* ignore */
      }
      throw new Error(`cannot connect to the ESPHome API at ${opts.host} (check host and encryption key)`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  conn.subscribeBluetoothAdvertisementService();
  const timer = setTimeout(done, seconds * 1000);
  await finished;
  clearTimeout(timer);
  try {
    conn.disconnect();
  } catch {
    /* ignore */
  }
  conn.frameHelper?.destroy?.();
  return [...found.values()];
}

export async function discoverNoble(
  seconds: number,
  onFound?: (m: FoundMachine) => void,
  stopOnFirst = false,
): Promise<FoundMachine[]> {
  const noble = ((await import('@stoprocent/noble')) as any).default;
  await noble.waitForPoweredOnAsync(15_000);
  const found = new Map<string, FoundMachine>();
  let done: () => void = () => undefined;
  const finished = new Promise<void>(r => (done = r));
  const onDiscover = (p: any) => {
    const name: string = p.advertisement?.localName ?? '';
    if (!isDelonghi(name, p.advertisement?.serviceUuids ?? [])) return;
    upsert(found, p.id, { address: p.address || '', id: p.id, bleName: name, rssi: p.rssi }, onFound);
    if (stopOnFirst && found.get(p.id)?.bleName) done();
  };
  noble.on('discover', onDiscover);
  await noble.startScanningAsync([], true);
  const timer = setTimeout(done, seconds * 1000);
  await finished;
  clearTimeout(timer);
  noble.removeListener('discover', onDiscover);
  await noble.stopScanningAsync();
  return [...found.values()];
}

/** Config snippet for a discovered machine. */
export function suggestedConfig(m: FoundMachine): Record<string, string> {
  const out: Record<string, string> = { bleName: m.bleName };
  if (m.address) out.address = m.address;
  if (m.productCode) out.productCode = m.productCode;
  return out;
}
