#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  type FoundMachine,
  type Logger,
  createMachine,
  discoverEsphome,
  discoverNoble,
  hex,
  identifyMachine,
  suggestedConfig,
} from 'delonghi-core';
import { MqttBridge } from './bridge.js';
import { loadConfig } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

function makeLogger(level: keyof typeof LEVELS): Logger {
  const min = LEVELS[level];
  const out = (l: keyof typeof LEVELS) => (msg: string, ...args: unknown[]) => {
    if (LEVELS[l] < min) return;
    const line = `${new Date().toISOString()} ${l.toUpperCase().padEnd(5)} ${msg}`;
    (l === 'error' || l === 'warn' ? console.error : console.log)(line, ...args);
  };
  return { debug: out('debug'), info: out('info'), warn: out('warn'), error: out('error') };
}

async function run(configPath: string, verbose: boolean): Promise<void> {
  const cfg = loadConfig(configPath);
  const log = makeLogger(verbose ? 'debug' : (cfg.logLevel ?? 'info'));
  const bridge = new MqttBridge(
    {
      url: cfg.mqtt.url,
      username: cfg.mqtt.username,
      password: cfg.mqtt.password,
      clientId: cfg.mqtt.clientId,
      baseTopic: cfg.mqtt.baseTopic ?? 'delonghi',
      haDiscovery: cfg.mqtt.haDiscovery ?? true,
      haDiscoveryPrefix: cfg.mqtt.haDiscoveryPrefix ?? 'homeassistant',
      watchdogSec: cfg.mqtt.watchdogSec ?? 180,
    },
    log,
  );
  for (const mc of cfg.machines) await identifyMachine(mc, log);
  const machines = cfg.machines.map(mc => createMachine(mc, log));
  for (const m of machines) {
    bridge.add(m);
    m.on('frame', (f: Buffer) => bridge.event(m, 'frame', { data: hex(f) }));
  }
  await bridge.start();
  for (const m of machines) m.start();

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig}: shutting down`);
    const force = setTimeout(() => process.exit(1), 8_000);
    await Promise.allSettled(machines.map(m => m.stop()));
    await bridge.stop().catch(() => undefined);
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function scan(seconds: number, esphomeHost?: string, key?: string): Promise<void> {
  const print = (m: FoundMachine) =>
    console.log(
      `found ${m.bleName || '?'}  ${m.address || `(id ${m.id}, MAC hidden by macOS)`}  rssi ${m.rssi}  ${m.model ?? 'unknown model'}`,
    );
  console.log(`scanning ${esphomeHost ? `via ESPHome proxy ${esphomeHost}` : 'with the local Bluetooth adapter'} for ${seconds}s...`);
  const found = esphomeHost
    ? await discoverEsphome({ host: esphomeHost, encryptionKey: key }, seconds, print)
    : await discoverNoble(seconds, print);
  if (found.length === 0) {
    console.log("no De'Longhi machine found. A machine that is connected to something else (phone app, Home Assistant) does not advertise.");
  } else {
    console.log('\nmachine entries for config.json:');
    for (const m of found) console.log(JSON.stringify(suggestedConfig(m)));
  }
  process.exit(0);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', short: 'c', default: 'config.json' },
    verbose: { type: 'boolean', short: 'v', default: false },
    esphome: { type: 'string' },
    key: { type: 'string' },
    seconds: { type: 'string', default: '20' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`delonghi2mqtt - De'Longhi BLE coffee machine <-> MQTT bridge

usage:
  delonghi2mqtt [-c config.json] [-v]          run the bridge
  delonghi2mqtt scan [--seconds 20]            find machines with the local Bluetooth adapter
  delonghi2mqtt scan --esphome <host> [--key <base64>]   find machines through an ESPHome proxy`);
  process.exit(0);
}

const main = positionals[0] === 'scan'
  ? scan(Number(values.seconds), values.esphome, values.key)
  : run(values.config!, values.verbose!);
main.catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
