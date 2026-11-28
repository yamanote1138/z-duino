#ifndef CLIENTS_H
#define CLIENTS_H

#include <stdint.h>

// Who is on each WebSocket connection: a person (counts, feeds the safety timer), the beam sensor (never does), or not yet known.
class Clients {
 public:
  static const int MAX = 8;
  void connected(uint8_t n) { if (n < MAX) _role[n] = PENDING; }
  void disconnected(uint8_t n) { if (n < MAX) _role[n] = NONE; }
  void message(uint8_t n, bool isSensorHello);
  int people() const;
  int sensor() const;   // -1 when no sensor is connected
  bool feedsSafety(uint8_t n) const { return n < MAX && _role[n] == PERSON; }
  bool isSensor(uint8_t n) const { return n < MAX && _role[n] == SENSOR; }

 private:
  enum Role : uint8_t { NONE, PENDING, PERSON, SENSOR };
  Role _role[MAX] = {};
};

#endif
