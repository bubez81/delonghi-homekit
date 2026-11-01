# homebridge-delonghi-mqtt

Apple Home for De'Longhi Bluetooth coffee machines, through the
[delonghi2mqtt](https://www.npmjs.com/package/delonghi2mqtt) bridge. The plugin
only speaks MQTT: run the bridge first (see
[delonghi-homekit](https://github.com/bubez81/delonghi-homekit)).

## Accessory

One **Coffee machine** accessory per machine:

- **Power** switch (primary). Standby is only sent when the bridge allows it
  (`allowPowerOff`); otherwise turning it off is ignored.
- **One switch per beverage**: on = brew (the machine is switched on first if
  needed), it turns itself off when dispensing ends; off = stop.
- **Dispensing** occupancy sensor.
- **Contact sensors**, open when attention is needed: water tank, grounds
  container, coffee beans, descaling, water filter. Enable *Status
  notifications* on them in Home to be alerted.

Everything shows *No Response* while the bridge or its Bluetooth link is down.

## Configuration

```json
{
  "platform": "DelonghiMqtt",
  "mqttUrl": "mqtt://localhost:1883",
  "username": "",
  "password": "",
  "baseTopic": "delonghi",
  "machines": [
    {
      "id": "coffee",
      "name": "Coffee machine",
      "beverages": ["Espresso Coffee", "Regular Coffee", "Cappuccino", "Latte Macchiato"],
      "beverageNames": { "Espresso Coffee": "Espresso" },
      "sensors": true
    }
  ]
}
```

With `machines` empty, every machine announced by the bridge is added with a
default set of beverages. `beverages` uses the catalog names published by the
bridge on `delonghi/<id>/info`; `beverageNames` sets the names shown in Home
(Italian names are used by default for the common beverages).

## License

Apache-2.0.
