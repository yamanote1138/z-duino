// Where the controller is: TRAIN_HOST, else ztrain.local resolved to an IP (mDNS names were unreliable for the WebSocket),
// else the name itself. Kept apart from the sensor's port search so the controller never depends on the sensor.
import { lookup } from "node:dns/promises";

export async function findHost(env = process.env, resolve = lookup) {
  if (env.TRAIN_HOST) return env.TRAIN_HOST;
  try { return (await resolve("ztrain.local", { family: 4 })).address; } catch { return "ztrain.local"; }
}
