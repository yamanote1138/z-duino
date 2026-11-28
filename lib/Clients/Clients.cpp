#include "Clients.h"

void Clients::message(uint8_t n, bool isSensorHello) {
  if (n >= MAX || _role[n] == NONE || _role[n] == SENSOR) return;
  if (!isSensorHello) { _role[n] = PERSON; return; }
  for (int i = 0; i < MAX; i++) if (_role[i] == SENSOR) _role[i] = NONE;   // a second sensor replaces the first
  _role[n] = SENSOR;
}

int Clients::people() const {
  int c = 0;
  for (int i = 0; i < MAX; i++) if (_role[i] == PERSON) c++;
  return c;
}

int Clients::sensor() const {
  for (int i = 0; i < MAX; i++) if (_role[i] == SENSOR) return i;
  return -1;
}
