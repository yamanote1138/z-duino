#ifndef LED_TIMING_H
#define LED_TIMING_H

// Pure timing/math for StatusLED's animated states. All take an explicit
// elapsed/phase time rather than calling millis() directly, so they can be
// tested without touching hardware.

// WIFI_CONNECTING breathing effect: sine-based brightness (0-1000) over a
// 2000ms cycle. Pass the raw current millis() value.
int breathingBrightness(unsigned long nowMs);

// Emergency-stop blink: whether the LED should be ON during this point in
// a single blink cycle (elapsedMs is time since the blink sequence started).
bool isBlinkFrameOn(unsigned long elapsedMs, unsigned long blinkOn, unsigned long blinkOff);

// Whether the full blink sequence (totalBlinks cycles) has finished.
bool isBlinkSequenceDone(unsigned long elapsedMs, unsigned long blinkCycle, int totalBlinks);

#endif
