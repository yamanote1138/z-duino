#include <Arduino.h>

// Beam sensor: prints "<A0 reading>,<microseconds>" about every 20 ms.
// The reading comes first so a plain integer parse still works; the timestamp
// lets the host time passes on the sensor's own clock instead of USB arrival.
void setup() {
  Serial.begin(115200);
}

void loop() {
  unsigned long t = micros();
  int v = analogRead(A0);
  Serial.print(v);
  Serial.print(',');
  Serial.println(t);
  delay(20);
}
