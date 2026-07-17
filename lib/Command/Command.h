#ifndef COMMAND_H
#define COMMAND_H

#include <stddef.h>

enum CommandType {
  CMD_UNKNOWN,
  CMD_INVALID_JSON,
  CMD_SPEED,
  CMD_DIRECTION,
  CMD_STOP,
  CMD_INVERT,
  CMD_LED,
  CMD_LED_AUTO,
  CMD_PING
};

struct Command {
  CommandType type = CMD_UNKNOWN;
  float speed = 0.0f;        // CMD_SPEED, already clamped to 0.0-1.0
  bool boolValue = false;    // CMD_DIRECTION / CMD_INVERT
  int ledR = 0;              // CMD_LED
  int ledG = 0;
  int ledB = 0;
};

// Pure parsing/dispatch decision: given a raw WebSocket text payload,
// figure out which command it is and extract its (defaulted, clamped)
// parameters. Does not touch the motor, LED, or network — the caller
// applies whatever side effects the returned Command implies.
Command parseCommand(const char* payload, size_t length);

#endif
