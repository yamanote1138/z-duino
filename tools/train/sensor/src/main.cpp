#include <Arduino.h>

// Beam sensor test: prints the photoresistor reading on A0 every 20 ms.
void setup() {
  Serial.begin(115200);
}

void loop() {
  Serial.println(analogRead(A0));
  delay(20);
}
