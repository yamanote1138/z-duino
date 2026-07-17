#include "Command.h"
#include <ArduinoJson.h>
#include <string.h>

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
  else {
    result.type = CMD_UNKNOWN;
  }

  return result;
}
