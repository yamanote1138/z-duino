#ifndef COMMAND_H
#define COMMAND_H

#include <stddef.h>
#include <GuardedCreep.h>

enum CommandType {
  CMD_UNKNOWN,
  CMD_INVALID_JSON,
  CMD_SPEED,
  CMD_DIRECTION,
  CMD_STOP,
  CMD_INVERT,
  CMD_LED,
  CMD_LED_AUTO,
  CMD_PING,
  CMD_HELLO,
  CMD_BEAM,
  CMD_BEAM_CALIBRATE,
  CMD_CREEP
};

// A message from the beam sensor: only the fields the controller acts on.
struct BeamMessage {
  char event[24] = "";
  int n = 0, median = 0, min = 0, max = 0; float sd = 0, mean = 0;   // measured
  char state[16] = ""; int level = 0; bool calibrated = false;        // heartbeat
  char error[96] = "";                                                // calibration_failed
};

struct Command {
  CommandType type = CMD_UNKNOWN;
  float speed = 0.0f;        // CMD_SPEED, already clamped to 0.0-1.0
  bool boolValue = false;    // CMD_DIRECTION / CMD_INVERT
  int ledR = 0;              // CMD_LED
  int ledG = 0;
  int ledB = 0;
  bool isSensor = false;      // CMD_HELLO with role "sensor"
  BeamMessage beam;          // CMD_BEAM
  CreepRequest creep;        // CMD_CREEP; valid is false for out-of-range arguments
};

// Pure parsing/dispatch decision: given a raw WebSocket text payload,
// figure out which command it is and extract its (defaulted, clamped)
// parameters. Does not touch the motor, LED, or network — the caller
// applies whatever side effects the returned Command implies.
Command parseCommand(const char* payload, size_t length);

// Turn a sensor's beam message into the one sent to clients, labeled with direction while the motor runs. Returns bytes written, 0 on bad input.
// Does a person's command end a running calibration? Anything that moves or reverses the motor does.
bool abortsCalibration(CommandType t);

size_t relayBeam(const char* payload, size_t length, bool moving, bool forward, char* out, size_t cap);

#endif
