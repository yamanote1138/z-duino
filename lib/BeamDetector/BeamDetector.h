#ifndef BEAM_DETECTOR_H
#define BEAM_DETECTOR_H

#include <stdint.h>
#include <string.h>

// Port of tools/train/lib/sensor/detector.mjs: beam readings in, events out. Pure logic, no hardware.

struct BeamLevels { int clear; int blocked; };

enum BeamEventType { BEAM_READY, BEAM_BREAK, BEAM_RESTORE, BEAM_PASS, BEAM_DRIFT };
enum DriftKind { DRIFT_LOW, DRIFT_HIGH, DRIFT_NOISY, DRIFT_PARTIAL };

struct BeamEvent {
  BeamEventType type;
  double t;              // ready/break/restore: sensor clock, ms
  int level;             // ready/break: the reading
  bool blocked;          // ready: the starting state
  double t0, t1, durationMs;   // pass: interpolated edges
  int minLevel; double meanLevel; int maxLevel;
  DriftKind drift; double estimate, sd; int calibrated;
};

struct BeamConfig {
  float breakFrac = 0.7f, restoreFrac = 0.8f;
  int breakSamples = 2, restoreSamples = 3;
  double estimateWindowMs = 2000, driftAfterMs = 4000;
  float driftFrac = 0.2f, partialFrac = 0.3f, noisyFrac = 0.1f;
};

struct Stats { int n; int median; double mean, sd; int min, max; };
Stats summarize(const int* v, int n);

struct Derived { bool ok; BeamLevels levels; char error[96]; char warnings[3][96]; int nWarnings; };
Derived deriveLevels(Stats a, Stats b);   // the higher median becomes clear

class ChangeWatch {
 public:
  void start(int from) { _from = from; _run = 0; _on = true; }
  void stop() { _on = false; }
  bool active() const { return _on; }
  bool push(int v);      // true once 2 readings in a row sit at least 40% of `from` and 150 counts away
 private:
  int _from = 0, _run = 0; bool _on = false;
};

class BeamDetector {
 public:
  static const int CLEAR_CAP = 128, BLOCK_CAP = 128, PASS_CAP = 512;
  explicit BeamDetector(BeamLevels lv, BeamConfig cfg = BeamConfig());
  void setLevels(BeamLevels lv);
  void restart(BeamLevels lv) { _lv = lv; reset(); }   // new levels and a fresh start, without a big temporary
  int push(double t, int v, BeamEvent* out, int max);
  const char* state() const;
  int clearEstimate() const;
  BeamLevels levels() const { return _lv; }
  double breakLevel() const { return _lv.blocked + _cfg.breakFrac * span(); }
  double restoreLevel() const { return _lv.blocked + _cfg.restoreFrac * span(); }

 private:
  struct S { double t; int v; };
  int span() const { return _lv.clear - _lv.blocked; }
  void reset();
  void pushClear(S s, BeamEvent* out, int& n, int max);
  void watchPartial(S s, BeamEvent* out, int& n, int max);
  void summarizePass(S last, BeamEvent& e);
  void passAdd(S s);
  static void ringStats(const S* buf, int head, int n, int cap, int* median, double* sd);

  BeamLevels _lv; BeamConfig _cfg;
  int _state;           // 0 init, 1 clear, 2 blocked
  int _low, _high;
  S _prev; bool _hasPrev; S _lowBefore; bool _hasLowBefore; S _lowFirst;
  S _clear[CLEAR_CAP]; int _clearHead, _clearN;
  S _block[BLOCK_CAP]; int _blockHead, _blockN;
  S _pass[PASS_CAP]; int _passN; bool _passOn;
  double _steadySince; bool _steady; double _blockedSince;
  int _driftKind;       // -1 none
  bool _partialFlagged;
};

#endif
