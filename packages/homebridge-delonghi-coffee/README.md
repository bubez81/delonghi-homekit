# homebridge-delonghi-coffee

Apple Home for De'Longhi Bluetooth coffee machines — PrimaDonna, Dinamica Plus,
Eletta, Maestosa and the other models of the De'Longhi Coffee Link app with a
Bluetooth connection. Local, no cloud, no account.

## What you get

One **Coffee machine** accessory:

- **Power** switch.
- **One switch per beverage** (Espresso, Coffee, Cappuccino…): turn it on to
  brew — if the machine is off it is switched on and the beverage starts once
  it's ready — and it turns itself off when the cup is done. Turning it off
  stops the beverage. Works with Siri: *"Hey Siri, turn on Cappuccino"*.
- **Dispensing** sensor.
- **Contact sensors** that open when the machine needs attention: water tank,
  grounds container, coffee beans, descaling, water filter. Turn on *Status
  notifications* for them in Home to be alerted.

Everything shows *No Response* while the machine can't be reached (e.g. unplugged).

## Requirements

The machine accepts **one Bluetooth connection at a time**: close the Coffee
Link app on your phone and remove other integrations that connect to it.

The plugin needs Bluetooth near the machine, one of:

- **An ESPHome Bluetooth proxy** (recommended) — any ESP32 flashed with the
  standard [Bluetooth proxy firmware](https://esphome.github.io/bluetooth-proxies/),
  placed near the machine. You need its IP and the API encryption key
  (`api: encryption: key:` in its YAML). ESPHome lends its Bluetooth to **one
  client at a time**: if Home Assistant uses the same proxy, disable it there
  (you can keep managing it from the ESPHome Device Builder).
- **The Homebridge server's own Bluetooth**, when it is in range of the machine.
  On Linux/Raspberry Pi give Node raw Bluetooth access:
  `sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))`.
  On macOS allow Bluetooth for Homebridge in *System Settings → Privacy & Security*.

## Configuration

Use the Homebridge UI, or:

```json
{
  "platform": "DelonghiCoffee",
  "name": "De'Longhi Coffee",
  "machines": [
    {
      "name": "Coffee machine",
      "connection": "esphome",
      "esphomeHost": "192.168.1.50",
      "esphomeKey": "<api encryption key>",
      "beverages": ["Espresso Coffee", "Regular Coffee", "Cappuccino", "Latte Macchiato"]
    }
  ]
}
```

| option | |
|---|---|
| `connection` | `esphome` (default), `local` (server Bluetooth) or `mqtt` (see below) |
| `esphomeHost`, `esphomeKey` | ESPHome proxy address and API key |
| `address`, `bleName` | optional. Without them the first De'Longhi machine found is used, and the values to pin are written to the log |
| `productCode` | optional, guessed from the Bluetooth name. Decides the available beverages |
| `beverages` | catalog names to expose (the log lists the ones your machine offers). Default: Espresso Coffee, Regular Coffee, Long Coffee, Cappuccino, Latte Macchiato |
| `beverageNames` | names shown in Home, e.g. `{"Espresso Coffee": "Espresso"}` |
| `sensors` | attention sensors, default `true` |
| `autoPowerOn` | switch the machine on when a beverage is requested, default `true` |
| `allowPowerOff` | send standby when the power switch is turned off. Default `false`: the command is confirmed only on some PrimaDonna/Maestosa models and does not work on the Dinamica Plus |
| `recipeOverrides` | per-beverage quantities, e.g. `{"Cappuccino": {"coffeeQty": 90, "milkQty": 200, "taste": 4}}` |

### Also want Home Assistant?

Since only one thing can talk to the machine, run the
[delonghi2mqtt](https://github.com/bubez81/delonghi-homekit/tree/main/packages/delonghi2mqtt)
bridge instead: it owns the Bluetooth connection, creates the Home Assistant
entities through MQTT discovery, and this plugin follows it with
`"connection": "mqtt"`, `"mqttId": "<bridge machine id>"` and an `mqtt` block
(`url`, `username`, `password`).

## Status

Tested on a Dinamica PLUS 370.95.T through an ESPHome proxy (status, sensors,
power on, espresso). Not yet verified: milk beverages (their commands are
generated from the De'Longhi catalog), the server-Bluetooth connection on real
hardware, other models. Please open an issue with your model and what works.

## Credits

Protocol and machine catalog from
[Arbuzov/home_assistant_delonghi_primadonna](https://github.com/Arbuzov/home_assistant_delonghi_primadonna)
(Apache-2.0). Not affiliated with De'Longhi.
