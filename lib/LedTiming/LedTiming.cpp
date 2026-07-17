#include "LedTiming.h"
#include <cmath>

int breathingBrightness(unsigned long nowMs) {
  float phase = (nowMs % 2000) / 2000.0f * 2.0f * (float)M_PI;
  return (int)((sin(phase - (float)M_PI / 2.0f) + 1.0f) / 2.0f * 1000.0f);
}

bool isBlinkFrameOn(unsigned long elapsedMs, unsigned long blinkOn, unsigned long blinkOff) {
  unsigned long cycleTime = elapsedMs % (blinkOn + blinkOff);
  return cycleTime < blinkOn;
}

bool isBlinkSequenceDone(unsigned long elapsedMs, unsigned long blinkCycle, int totalBlinks) {
  int currentBlink = elapsedMs / blinkCycle;
  return currentBlink >= totalBlinks;
}
