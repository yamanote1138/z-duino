// Compatibility for the older scripts (they import HOST and PORT). New code uses lib/config/index.mjs instead; this file
// goes when the last old script is migrated. It honours the same settings (local/config.jsonc, TRAIN_HOST, SENSOR_PORT).
//   HOST  the controller's address (controller.host, else ztrain.local resolved to an IP)
//   PORT  the sensor's serial port (sensor.port, else the only /dev/cu.usbmodem*); exits with advice if there is none

import { readdirSync } from "node:fs";
import { findHost } from "./controller/host.mjs";
import { loadConfigOrExit } from "./config/index.mjs";

const config = loadConfigOrExit();

function findPort() {
  if (config.sensor.port) return config.sensor.port;
  const found = readdirSync("/dev").filter((f) => f.startsWith("cu.usbmodem")).map((f) => `/dev/${f}`);
  if (found.length === 1) return found[0];
  console.error(found.length ? `several sensor ports (${found.join(", ")}): set sensor.port in local/config.jsonc, or SENSOR_PORT` : "no /dev/cu.usbmodem* found: is the sensor Arduino plugged in directly (not through a power-only adapter)? Or set sensor.port / SENSOR_PORT");
  process.exit(1);
}

export const HOST = config.controller.host || await findHost();
export const PORT = findPort();
