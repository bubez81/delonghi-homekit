# De'Longhi coffee machines for Apple Home (and Home Assistant)

Local control of De'Longhi Bluetooth coffee machines — PrimaDonna, Dinamica
Plus, Eletta, Maestosa and the other Coffee Link models with Bluetooth.

> **Based on the work of [Sergey Arbuzov](https://github.com/Arbuzov) and contributors.**
> The De'Longhi Bluetooth protocol (frame format, CRC, status and alarm decoding,
> captured beverage commands) and the machine catalog used here come from his Home
> Assistant integration
> [home_assistant_delonghi_primadonna](https://github.com/Arbuzov/home_assistant_delonghi_primadonna)
> (Apache-2.0). This project is a port of that work to Node.js for Homebridge and MQTT;
> if you use Home Assistant only, his integration is the original — go give it a ⭐.

## Just Apple Home → [homebridge-delonghi-coffee](packages/homebridge-delonghi-coffee)

Install **homebridge-delonghi-coffee** from the Homebridge UI. It talks to the
machine directly, through an ESPHome Bluetooth proxy or the server's Bluetooth:

```
Coffee machine ──BLE──► Homebridge (homebridge-delonghi-coffee) ──► Apple Home
```

One accessory with power, a switch per beverage ("Hey Siri, turn on
Cappuccino"), a dispensing sensor and sensors for water tank, grounds,
beans, descaling and filter.

## Apple Home and Home Assistant → [delonghi2mqtt](packages/delonghi2mqtt)

The machine accepts a single Bluetooth connection, so when both need it a
small bridge owns the connection and shares it over MQTT:

```
Coffee machine ──BLE──► delonghi2mqtt ──► MQTT ──┬──► Home Assistant (MQTT discovery)
                                                  └──► Homebridge (homebridge-delonghi-coffee, "mqtt" connection)
```

## Repository

| package | |
|---|---|
| [`packages/homebridge-delonghi-coffee`](packages/homebridge-delonghi-coffee) | Homebridge plugin (published on npm) |
| [`packages/delonghi2mqtt`](packages/delonghi2mqtt) | Bluetooth ↔ MQTT bridge with Home Assistant discovery |
| [`packages/core`](packages/core) | protocol, machine controller, Bluetooth transports, model catalog (bundled into both) |

```sh
npm install && npm run build && npm test
```

## Status

Tested on a Dinamica PLUS 370.95.T through an ESPHome proxy. Not yet verified:
milk beverages (generated from the catalog), the server-Bluetooth transport on
real hardware, other models. Standby works only on some models and is off by
default. Reports welcome.

## Credits

The Bluetooth protocol and the machine catalog come from
[home_assistant_delonghi_primadonna](https://github.com/Arbuzov/home_assistant_delonghi_primadonna)
by [Sergey Arbuzov](https://github.com/Arbuzov) and its contributors (Apache-2.0);
beverage ingredient ids follow [longshot](https://github.com/mmastrac/longshot) by Matt Mastracci.
Not affiliated with De'Longhi. Apache-2.0, see [NOTICE](NOTICE).
