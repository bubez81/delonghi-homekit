# De'Longhi coffee machines → MQTT → HomeKit / Home Assistant

Control De'Longhi Bluetooth coffee machines (PrimaDonna, Dinamica Plus, Eletta,
Maestosa… — every model of the De'Longhi Coffee Link app with a BT connection)
from Home Assistant and Apple Home, without the cloud.

```
Coffee machine ──BLE──► delonghi2mqtt ──► MQTT broker ──┬──► Home Assistant (MQTT discovery)
                                                         └──► Homebridge (homebridge-delonghi-mqtt) ──► Apple Home
```

The machine accepts **one** Bluetooth connection at a time. `delonghi2mqtt` is
the only thing that talks to it; Home Assistant, Homebridge and anything else
use MQTT. Before starting it, close the Coffee Link app and remove other
integrations that connect to the machine (e.g. the HACS `delonghi_primadonna`
integration).

| package | |
|---|---|
| [`delonghi2mqtt`](packages/delonghi2mqtt) | the bridge: Bluetooth ↔ MQTT, Home Assistant discovery |
| [`homebridge-delonghi-mqtt`](packages/homebridge-delonghi-mqtt) | Homebridge plugin (MQTT only) |

## What you get

- **Home Assistant**: a device with status, alarms, nozzle, dispensing progress,
  counters (coffees, water, descaling…), a beverage selector, profile, sounds,
  energy saving, auto-off, water hardness/temperature.
- **Apple Home**: one *Coffee machine* accessory with a power switch, one switch
  per beverage ("Hey Siri, turn on Cappuccino": switches the machine on, waits
  until it is ready, brews, turns itself off when done), a *dispensing*
  sensor and contact sensors that open when the water tank, grounds container,
  beans, descaling or water filter need attention (enable notifications on them).

## 1. Bluetooth: pick a transport

| | when | config |
|---|---|---|
| **ESPHome Bluetooth proxy** | an ESP32 near the machine, the server is far away | `{"type": "esphome", "host": "<ip>", "encryptionKey": "<api key>"}` |
| **Local adapter** | the server running the bridge is in Bluetooth range (Raspberry Pi, Mac, Linux box) | `{"type": "noble"}` |

**ESPHome proxy notes.** Any ESP32 flashed with the standard
[Bluetooth proxy](https://esphome.github.io/bluetooth-proxies/) firmware works;
the API encryption key is the `api: encryption: key:` value in its YAML.
ESPHome serves Bluetooth to **one API client at a time**: if Home Assistant
also uses this proxy, disable it in Home Assistant (*Settings → Devices &
services → ESPHome → the proxy → Disable*). You can keep managing the device
from the ESPHome Device Builder as usual.

**Local adapter notes.** On Linux, Node needs raw Bluetooth access
(`sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))`) and BlueZ must
not hold the adapter. On macOS, allow Bluetooth for the terminal/`node` the
first time (*System Settings → Privacy & Security → Bluetooth*); macOS hides
MAC addresses, so the machine is matched by its name.

## 2. Find the machine (optional)

You don't need the MAC address: when the config does not name a machine, the
bridge connects to the first De'Longhi machine it hears and logs the values to
pin. To look before configuring:

```sh
npx delonghi2mqtt scan                                     # local Bluetooth
npx delonghi2mqtt scan --esphome 192.168.1.50 --key <api key>
```

```
found D1533201  00:A0:50:12:34:56  rssi -62  Dinamica PLUS 370.95.T
machine entries for config.json:
{"bleName":"D1533201","address":"00:A0:50:12:34:56","productCode":"0132215332"}
```

A machine connected to something else (phone app, Home Assistant) does not
advertise and won't be found.

## 3. Run the bridge

```sh
npm install -g delonghi2mqtt
delonghi2mqtt -c config.json        # -v logs every Bluetooth frame
```

Minimal `config.json`:

```json
{
  "mqtt": { "url": "mqtt://localhost:1883", "username": "", "password": "" },
  "machines": [
    { "id": "coffee", "name": "Coffee machine",
      "transport": { "type": "esphome", "host": "192.168.1.50", "encryptionKey": "<api key>" } }
  ]
}
```

See [packages/delonghi2mqtt](packages/delonghi2mqtt) for all options, the MQTT
topics and running it as a service (systemd / launchd).

## 4. Homebridge

Install `homebridge-delonghi-mqtt` from the Homebridge UI and set the broker. See
[packages/homebridge-delonghi-mqtt](packages/homebridge-delonghi-mqtt).

## Status

Tested on a **Dinamica PLUS 370.95.T** through an ESPHome proxy: status, settings,
statistics, profiles, power on, espresso. Not yet verified: milk beverages
(their commands are generated from the catalog, see below), the local adapter
transport on real hardware, other models. Reports welcome.

- **Power off / standby**: the standby command is confirmed only on some
  PrimaDonna/Maestosa models and is known not to work on the Dinamica Plus,
  so it is disabled unless `allowPowerOff: true`.
- **Beverages**: Espresso, Coffee, Long, 2× Espresso, Doppio+, Americano and Hot
  Water use frames captured from the official app. Other recipes are built from
  the catalog quantities (ingredient TLVs: `01` coffee, `09` milk, `0f` hot
  water as 16 bit; `02` taste); tune them with `recipeOverrides`.

## Development

```sh
npm install && npm run build && npm test
```

## Credits

The Bluetooth protocol and the machine catalog come from
[Arbuzov/home_assistant_delonghi_primadonna](https://github.com/Arbuzov/home_assistant_delonghi_primadonna)
(Apache-2.0); ingredient ids follow [longshot](https://github.com/mmastrac/longshot).
Not affiliated with De'Longhi. Licensed under Apache-2.0, see [NOTICE](NOTICE).
