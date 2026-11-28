#include <Arduino.h>
#ifdef ESP8266
#include <ESP8266WiFi.h>
#endif

// Beam sensor: prints "<A0 reading>,<microseconds>" about every 20 ms.
// The reading comes first so a plain integer parse still works; the timestamp
// lets the host time passes on the sensor's own clock instead of USB arrival.
void setup() {
#ifdef ESP8266
  // WiFi off: the radio adds ADC noise and frequent analogRead upsets it anyway.
  WiFi.mode(WIFI_OFF);
  WiFi.forceSleepBegin();
#endif
  Serial.begin(115200);
#ifdef BEAM_SELFTEST
  pinMode(D5, OUTPUT);
#endif
}

void loop() {
  unsigned long t = micros();
#ifdef BEAM_SELFTEST
  digitalWrite(D5, HIGH);   // bench test: emitter on D5 stays lit
#endif
  int v = analogRead(A0);
  Serial.print(v);
  Serial.print(',');
  Serial.println(t);
  delay(20);
}
