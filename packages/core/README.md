# delonghi-core

Shared, unpublished library: De'Longhi ECAM Bluetooth protocol (framing, CRC,
monitor/statistics/settings parsing, beverage commands), the `Machine`
controller (single persistent connection, request queue, polling, brew
tracking with auto power-on), transports (`noble` local adapter, ESPHome
Bluetooth proxy), machine discovery and the model catalog. Bundled into the
Homebridge plugin; used by delonghi2mqtt through the npm workspace.
