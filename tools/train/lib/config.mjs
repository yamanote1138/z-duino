// Where the train controller and the sensor Arduino are. Both move around (the controller's address changes with DHCP,
// the Arduino's serial name changes with the USB port), so nothing is hard-coded:
//   TRAIN_HOST   env, else ztrain.local resolved to an IP (mDNS names were unreliable for the WebSocket), else the name
//   SENSOR_PORT  env, else the only /dev/cu.usbmodem* present (the controller is a usbserial device, so it is never matched)

import { readdirSync } from "node:fs";
import { findHost } from "./controller/host.mjs";

function findPort() {
  if (process.env.SENSOR_PORT) return process.env.SENSOR_PORT;
  const found = readdirSync("/dev").filter((f) => f.startsWith("cu.usbmodem")).map((f) => `/dev/${f}`);
  if (found.length === 1) return found[0];
  console.error(found.length ? `several sensor ports (${found.join(", ")}): set SENSOR_PORT` : "no /dev/cu.usbmodem* found: is the sensor Arduino plugged in directly (not through a power-only adapter)? Or set SENSOR_PORT");
  process.exit(1);
}

export const HOST = await findHost();
export const PORT = findPort();
