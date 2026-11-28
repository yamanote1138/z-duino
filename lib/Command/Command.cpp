#include "Command.h"
#include <ArduinoJson.h>
#include <string.h>
#include <stdio.h>

Command parseCommand(const char* payload, size_t length) {
  Command result;

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) {
    result.type = CMD_INVALID_JSON;
    return result;
  }

  const char* cmd = doc["cmd"];
  if (!cmd) {
    result.type = CMD_UNKNOWN;
    return result;
  }

  if (strcmp(cmd, "speed") == 0) {
    float value = doc["value"] | 0.0f;
    if (value < 0.0f) value = 0.0f;
    if (value > 1.0f) value = 1.0f;
    result.type = CMD_SPEED;
    result.speed = value;
  }
  else if (strcmp(cmd, "direction") == 0) {
    result.type = CMD_DIRECTION;
    result.boolValue = doc["value"] | true;
  }
  else if (strcmp(cmd, "stop") == 0) {
    result.type = CMD_STOP;
  }
  else if (strcmp(cmd, "invert") == 0) {
    result.type = CMD_INVERT;
    result.boolValue = doc["value"] | false;
  }
  else if (strcmp(cmd, "led") == 0) {
    result.type = CMD_LED;
    result.ledR = doc["r"] | 0;
    result.ledG = doc["g"] | 0;
    result.ledB = doc["b"] | 0;
  }
  else if (strcmp(cmd, "led_auto") == 0) {
    result.type = CMD_LED_AUTO;
  }
  else if (strcmp(cmd, "ping") == 0) {
    result.type = CMD_PING;
  }
  else if (strcmp(cmd, "hello") == 0) {
    result.type = CMD_HELLO;
    const char* role = doc["role"] | "";
    result.isSensor = strcmp(role, "sensor") == 0;
  }
  else if (strcmp(cmd, "beam_calibrate") == 0) {
    result.type = CMD_BEAM_CALIBRATE;
  }
  else if (strcmp(cmd, "beam") == 0) {
    result.type = CMD_BEAM;
    BeamMessage& b = result.beam;
    snprintf(b.event, sizeof(b.event), "%s", (const char*)(doc["event"] | ""));
    b.n = doc["n"] | 0; b.median = doc["median"] | 0; b.min = doc["min"] | 0; b.max = doc["max"] | 0;
    b.sd = doc["sd"] | 0.0f; b.mean = doc["mean"] | 0.0f;
    snprintf(b.state, sizeof(b.state), "%s", (const char*)(doc["state"] | ""));
    b.level = doc["level"] | 0; b.calibrated = doc["calibrated"] | false;
    snprintf(b.error, sizeof(b.error), "%s", (const char*)(doc["error"] | ""));
  }
  else {
    result.type = CMD_UNKNOWN;
  }

  return result;
}

size_t relayBeam(const char* payload, size_t length, bool moving, bool forward, char* out, size_t cap) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return 0;
  doc.remove("cmd");
  doc["type"] = "beam";
  const char* ev = doc["event"] | "";
  bool brk = strcmp(ev, "break") == 0, rst = strcmp(ev, "restore") == 0;
  if (moving && (brk || rst || strcmp(ev, "pass") == 0)) {
    doc["direction"] = forward ? "forward" : "reverse";
    if (brk) doc["edge"] = forward ? "nose" : "tail";        // the leading end arrives first
    if (rst) doc["edge"] = forward ? "tail" : "nose";
  }
  size_t n = serializeJson(doc, out, cap);
  return n < cap ? n : 0;
}
