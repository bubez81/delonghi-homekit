# Changelog

## 0.1.2

- Milk beverages: tags sent in ascending order with the milk carafe accessory
  (`1c 02`) last, as captured from the Coffee Link app
  (home_assistant_delonghi_primadonna PR #281).
- Frames longer than 20 bytes are written in 20-byte chunks (the machine's
  ATT MTU is 23).
- Auto power-on no longer treats the `clean_knob` prompt that follows a milk
  beverage as a blocking alarm.
- Prominent credit to Sergey Arbuzov's home_assistant_delonghi_primadonna.

## 0.1.1

- Water hardness, water temperature and auto-off are read from the machine
  (they were only known after being set).
- Standby: documented the commands tested without effect on the Dinamica Plus.

## 0.1.0

- First release: direct connection through an ESPHome Bluetooth proxy or the
  server's Bluetooth, or through the delonghi2mqtt bridge; machine
  auto-discovery; one accessory with power, beverages, dispensing and
  attention sensors.
