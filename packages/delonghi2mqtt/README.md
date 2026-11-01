# delonghi2mqtt

Bridge between De'Longhi Bluetooth coffee machines and MQTT, with Home Assistant
MQTT discovery. Part of [delonghi-homekit](https://github.com/bubez81/delonghi-homekit) —
see there for the overview and the Bluetooth setup.

```sh
npm install -g delonghi2mqtt
delonghi2mqtt scan [--esphome <host> --key <api key>]   # find machines
delonghi2mqtt -c config.json [-v]                       # run
```

## Configuration

```json
{
  "logLevel": "info",
  "mqtt": {
    "url": "mqtt://localhost:1883",
    "username": "",
    "password": "",
    "baseTopic": "delonghi",
    "haDiscovery": true,
    "haDiscoveryPrefix": "homeassistant"
  },
  "machines": [
    {
      "id": "coffee",
      "name": "Coffee machine",
      "transport": { "type": "esphome", "host": "192.168.1.50", "encryptionKey": "<api key>" },
      "address": "00:A0:50:12:34:56",
      "bleName": "D1533201",
      "productCode": "0132215332",
      "allowPowerOff": false,
      "autoPowerOn": true,
      "pollIntervalSec": 30,
      "statsIntervalSec": 600,
      "recipeOverrides": { "Cappuccino": { "coffeeQty": 90, "milkQty": 200, "taste": 4 } }
    }
  ]
}
```

| key | |
|---|---|
| `id` | topic-safe id used in MQTT topics |
| `transport` | `{"type": "noble"}` (local adapter) or `{"type": "esphome", "host", "port"?, "encryptionKey"?}` |
| `address`, `bleName` | optional: without them the first machine found is used and the values to pin are logged |
| `productCode` | catalog entry (beverages, features). Guessed from `bleName` when omitted |
| `allowPowerOff` | expose standby. Off by default: it does not work on every model |
| `autoPowerOn` | a beverage requested while the machine is off switches it on and starts once ready |
| `recipeOverrides` | per-beverage `coffeeQty`, `milkQty`, `hotWaterQty` (ml) and `taste` (1–5) |

`MQTT_USERNAME`, `MQTT_PASSWORD` and `ESPHOME_API_KEY` environment variables are
used when the values are missing from the file.

## MQTT

| topic | |
|---|---|
| `delonghi/bridge/state` | `online` / `offline` (retained, LWT) |
| `delonghi/<id>/availability` | Bluetooth link to the machine: `online` / `offline` (retained) |
| `delonghi/<id>/state` | JSON (retained): `power`, `machine_state`, `status`, `alarms`, `problems.*`, `dispensing`, `progress`, `beverage`, `beverage_phase`, `nozzle`, `profile`, `profiles`, `settings.*`, `stats.*` |
| `delonghi/<id>/info` | JSON (retained): model, `beverages`, `features` |
| `delonghi/<id>/event` | `brew_requested`, `error`, `raw_reply`, `frame` |

Commands on `delonghi/<id>/set/<command>`:

| command | payload |
|---|---|
| `power_on`, `power_off`, `power` | –, –, `ON`/`OFF` |
| `brew` | beverage name (see `info.beverages`) or recipe id; `none` cancels |
| `cancel` | stop the current beverage |
| `profile` | profile name or id |
| `sounds`, `energy_save`, `cup_light` | `ON`/`OFF` |
| `auto_off` | `15min` `30min` `1h` `2h` `3h` |
| `water_hardness` | `soft` `medium` `hard` `very_hard` |
| `water_temperature` | `low` `medium` `high` `highest` |
| `refresh` | re-read settings and statistics |
| `raw` | hex frame (CRC recomputed); the reply is published as an `event` |

## Running as a service

**Linux (systemd)**, `/etc/systemd/system/delonghi2mqtt.service`:

```ini
[Unit]
Description=delonghi2mqtt
After=network-online.target bluetooth.target

[Service]
ExecStart=/usr/bin/env delonghi2mqtt -c /etc/delonghi2mqtt/config.json
Restart=always
User=delonghi

[Install]
WantedBy=multi-user.target
```

**macOS (launchd)**: `bash launchd/install.sh /path/to/config.json` installs a
LaunchAgent for the current user (a LaunchAgent, not a daemon, so the local
Bluetooth transport gets the user's Bluetooth permission).

## License

Apache-2.0. Protocol and catalog derived from
[home_assistant_delonghi_primadonna](https://github.com/Arbuzov/home_assistant_delonghi_primadonna).
