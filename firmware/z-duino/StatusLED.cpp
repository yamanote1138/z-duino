#include "StatusLED.h"

StatusLED::StatusLED(int pinR, int pinG, int pinB)
  : _pinR(pinR), _pinG(pinG), _pinB(pinB), _state(WIFI_CONNECTING)
{
  pinMode(_pinR, OUTPUT);
  pinMode(_pinG, OUTPUT);
  pinMode(_pinB, OUTPUT);
  // Common cathode: 0 = fully off
  analogWrite(_pinR, 0);
  analogWrite(_pinG, 0);
  analogWrite(_pinB, 0);
}

void StatusLED::setColor(int r, int g, int b) {
  // Common cathode: value maps directly to PWM duty cycle
  // 3.3V GPIO with ~3.0V Vf on green/blue = minimal headroom, no cap needed
  analogWrite(_pinR, r);
  analogWrite(_pinG, g);
  analogWrite(_pinB, b);
}

void StatusLED::setState(LEDState state) {
  _state = state;
  switch (_state) {
    case WIFI_CONNECTING:
      // Handled in update()
      break;
    case IDLE:
      setColor(0, 0, 1000);   // Blue
      break;
    case ACTIVE_FORWARD:
      setColor(0, 1000, 0);   // Green
      break;
    case ACTIVE_REVERSE:
      setColor(1000, 0, 0);   // Red
      break;
  }
}

void StatusLED::setTestColor(int r, int g, int b) {
  _state = LED_TEST;
  setColor(r, g, b);
}

void StatusLED::update() {
  if (_state != WIFI_CONNECTING) return;

  // Sine-based breathing on red channel, ~2s cycle
  float phase = (millis() % 2000) / 2000.0f * 2.0f * PI;
  int brightness = (int)((sin(phase - PI / 2.0f) + 1.0f) / 2.0f * 1000.0f);
  setColor(brightness, 0, 0);
}
