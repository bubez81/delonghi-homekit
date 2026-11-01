import { EventEmitter } from 'node:events';

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface MachineTarget {
  /** MAC address, e.g. 00:A0:50:12:34:56 (not usable with noble on macOS). */
  address?: string;
  /** Advertised BLE name, e.g. D1533201. */
  bleName?: string;
}

/**
 * A GATT link to the machine's control characteristic.
 * Events: 'data' (chunk: Buffer), 'disconnect' (reason?: string)
 */
export interface BleTransport extends EventEmitter {
  readonly name: string;
  connect(): Promise<void>;
  write(data: Buffer): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  close(): Promise<void>;
}

export function normalizeMac(mac: string): string {
  return mac.replace(/[^0-9a-f]/gi, '').toLowerCase();
}

export function macToNumber(mac: string): number {
  return parseInt(normalizeMac(mac), 16);
}

export function numberToMac(n: number): string {
  return n
    .toString(16)
    .padStart(12, '0')
    .match(/../g)!
    .join(':')
    .toUpperCase();
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${what}`)), ms);
    p.then(
      v => {
        clearTimeout(t);
        resolve(v);
      },
      e => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
