#include "BeamDetector.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static int cmpInt(const void* a, const void* b) { return *(const int*)a - *(const int*)b; }

Stats summarize(const int* v, int n) {
  Stats s = {0, 0, 0, 0, 0, 0};
  if (n <= 0) return s;
  int* tmp = (int*)malloc(sizeof(int) * n);
  double sum = 0;
  for (int i = 0; i < n; i++) { tmp[i] = v[i]; sum += v[i]; }
  qsort(tmp, n, sizeof(int), cmpInt);
  s.n = n; s.median = tmp[n / 2]; s.min = tmp[0]; s.max = tmp[n - 1]; s.mean = sum / n;
  double acc = 0;
  for (int i = 0; i < n; i++) acc += (v[i] - s.mean) * (v[i] - s.mean);
  s.sd = sqrt(acc / n);
  free(tmp);
  return s;
}

Derived deriveLevels(Stats a, Stats b) {
  Derived d; memset(&d, 0, sizeof(d));
  Stats clear = a.median >= b.median ? a : b, blocked = a.median >= b.median ? b : a;
  int span = clear.median - blocked.median;
  if (span < 60) {
    snprintf(d.error, sizeof(d.error), "blocked (%d) and clear (%d) are only %d counts apart (need 60+)", blocked.median, clear.median, span);
    return d;
  }
  d.ok = true; d.levels = {clear.median, blocked.median};
  if (clear.sd > 0.05 * span) snprintf(d.warnings[d.nWarnings++], 96, "the clear reading is noisy (sd %.1f)", clear.sd);
  if (blocked.sd > 0.05 * span) snprintf(d.warnings[d.nWarnings++], 96, "the blocked reading is noisy (sd %.1f)", blocked.sd);
  if (clear.max - clear.min > 0.3 * span) snprintf(d.warnings[d.nWarnings++], 96, "the clear reading wandered from %d to %d", clear.min, clear.max);
  return d;
}

bool ChangeWatch::push(int v) {
  if (!_on) return false;
  double need = 0.4 * _from; if (need < 150) need = 150;
  if (fabs((double)v - _from) >= need) { if (++_run >= 2) return true; }
  else _run = 0;
  return false;
}

BeamDetector::BeamDetector(BeamLevels lv, BeamConfig cfg) : _lv(lv), _cfg(cfg) { reset(); }

void BeamDetector::reset() {
  _state = 0; _low = _high = 0; _hasPrev = _hasLowBefore = false;
  _clearHead = _clearN = _blockHead = _blockN = _passN = 0; _passOn = false;
  _steady = false; _steadySince = 0; _blockedSince = 0; _driftKind = -1; _partialFlagged = false;
}

void BeamDetector::setLevels(BeamLevels lv) { _lv = lv; }

const char* BeamDetector::state() const { return _state == 0 ? "init" : _state == 1 ? "clear" : "blocked"; }

int BeamDetector::clearEstimate() const {
  if (_clearN < 5) return _lv.clear;
  int m; double sd;
  ringStats(_clear, _clearHead, _clearN, CLEAR_CAP, &m, &sd);
  return m;
}

// Median and standard deviation of a ring buffer's readings.
void BeamDetector::ringStats(const S* buf, int head, int n, int cap, int* median, double* sd) {
  int scratch[CLEAR_CAP > BLOCK_CAP ? CLEAR_CAP : BLOCK_CAP]; double sum = 0;
  for (int i = 0; i < n; i++) { scratch[i] = buf[(head + i) % cap].v; sum += scratch[i]; }
  double m = sum / n, acc = 0;
  for (int i = 0; i < n; i++) acc += (scratch[i] - m) * (scratch[i] - m);
  *sd = sqrt(acc / n);
  qsort(scratch, n, sizeof(int), cmpInt);
  *median = scratch[n / 2];
}

void BeamDetector::passAdd(S s) {
  if (!_passOn) return;
  if (_passN >= PASS_CAP) { _passOn = false; return; }
  _pass[_passN++] = s;
}

int BeamDetector::push(double t, int v, BeamEvent* out, int max) {
  int n = 0; S s = {t, v};
  S prev = _prev; bool hadPrev = _hasPrev;
  _prev = s; _hasPrev = true;
  double brk = breakLevel(), rst = restoreLevel();
  if (_state == 0) {
    _state = v >= brk ? 1 : 2;
    if (_state == 2) _blockedSince = t;
    if (n < max) { BeamEvent& e = out[n++]; memset(&e, 0, sizeof(e)); e.type = BEAM_READY; e.t = t; e.level = v; e.blocked = _state == 2; }
    if (_state == 1) { _steady = true; _steadySince = t; }
    return n;
  }
  if (_state == 1) {
    if (v >= brk) { pushClear(s, out, n, max); _low = 0; return n; }
    if (_low++ == 0) { _hasLowBefore = hadPrev; _lowBefore = prev; _lowFirst = s; }
    _steady = false;
    if (_low >= _cfg.breakSamples) {
      _state = 2; _high = 0; _low = 0; _blockN = 0; _blockHead = 0; _blockedSince = _lowFirst.t; _partialFlagged = false;
      _passOn = true; _passN = 0;
      if (_hasLowBefore) passAdd(_lowBefore);
      passAdd(_lowFirst);
      if (s.t != _lowFirst.t) passAdd(s);
      if (n < max) { BeamEvent& e = out[n++]; memset(&e, 0, sizeof(e)); e.type = BEAM_BREAK; e.t = _lowFirst.t; e.level = _lowFirst.v; }
    }
    return n;
  }
  watchPartial(s, out, n, max);
  passAdd(s);
  if (v >= rst) {
    if (++_high >= _cfg.restoreSamples) {
      _state = 1; _high = 0; _low = 0; _steady = true; _steadySince = t;
      if (n < max) { BeamEvent& e = out[n++]; memset(&e, 0, sizeof(e)); e.type = BEAM_RESTORE; e.t = t; }
      if (_passOn && _passN > 0 && n < max) { BeamEvent& e = out[n++]; memset(&e, 0, sizeof(e)); e.type = BEAM_PASS; summarizePass(s, e); }
      _passOn = false;
    }
  } else _high = 0;
  return n;
}

void BeamDetector::summarizePass(S last, BeamEvent& e) {
  int clear = clearEstimate(), mn = _pass[0].v;
  for (int i = 1; i < _passN; i++) if (_pass[i].v < mn) mn = _pass[i].v;
  double mid = (clear + mn) / 2.0;
  double fall = _passN > 1 ? _pass[1].t : _pass[0].t, rise = last.t;
  for (int k = 1; k < _passN; k++) {
    S a = _pass[k - 1], b = _pass[k];
    if (b.v < mid && a.v >= mid) { fall = a.t + ((a.v - mid) / (a.v - b.v)) * (b.t - a.t); break; }
  }
  for (int k = _passN - 2; k >= 0; k--) {
    S a = _pass[k], b = _pass[k + 1];
    if (a.v < mid && b.v >= mid) { rise = a.t + ((mid - a.v) / (b.v - a.v)) * (b.t - a.t); break; }
  }
  double sum = 0; int cnt = 0, mx = mn;
  for (int i = 0; i < _passN; i++) if (_pass[i].t >= fall && _pass[i].t <= rise) { sum += _pass[i].v; cnt++; if (_pass[i].v > mx || cnt == 1) mx = _pass[i].v; }
  e.t0 = fall; e.t1 = rise; e.durationMs = rise - fall; e.t = fall;
  e.minLevel = mn; e.meanLevel = cnt ? sum / cnt : mn; e.maxLevel = cnt ? mx : mn;
}

void BeamDetector::pushClear(S s, BeamEvent* out, int& n, int max) {
  int idx = (_clearHead + _clearN) % CLEAR_CAP;
  if (_clearN < CLEAR_CAP) _clearN++; else _clearHead = (_clearHead + 1) % CLEAR_CAP;
  _clear[idx] = s;
  while (_clearN && s.t - _clear[_clearHead].t > _cfg.estimateWindowMs) { _clearHead = (_clearHead + 1) % CLEAR_CAP; _clearN--; }
  if (!_steady) { _steady = true; _steadySince = s.t; }
  if (s.t - _steadySince < _cfg.driftAfterMs || _clearN < 20) return;
  int est; double sd;
  ringStats(_clear, _clearHead, _clearN, CLEAR_CAP, &est, &sd);
  int cal = _lv.clear, kind = -1;
  if (est < cal * (1 - _cfg.driftFrac)) kind = DRIFT_LOW;
  else if (est > cal * (1 + _cfg.driftFrac)) kind = DRIFT_HIGH;
  else if (sd > _cfg.noisyFrac * span()) kind = DRIFT_NOISY;
  if (kind >= 0 && kind != _driftKind) {
    _driftKind = kind;
    if (n < max) { BeamEvent& e = out[n++]; memset(&e, 0, sizeof(e)); e.type = BEAM_DRIFT; e.t = s.t; e.drift = (DriftKind)kind; e.estimate = est; e.sd = sd; e.calibrated = cal; }
  } else if (kind < 0) _driftKind = -1;
}

void BeamDetector::watchPartial(S s, BeamEvent* out, int& n, int max) {
  int idx = (_blockHead + _blockN) % BLOCK_CAP;
  if (_blockN < BLOCK_CAP) _blockN++; else _blockHead = (_blockHead + 1) % BLOCK_CAP;
  _block[idx] = s;
  while (_blockN && s.t - _block[_blockHead].t > _cfg.estimateWindowMs) { _blockHead = (_blockHead + 1) % BLOCK_CAP; _blockN--; }
  if (_partialFlagged || s.t - _blockedSince < _cfg.driftAfterMs || _blockN < 20) return;
  int est; double sd;
  ringStats(_block, _blockHead, _blockN, BLOCK_CAP, &est, &sd);
  if (est >= _lv.blocked + _cfg.partialFrac * span() && sd < _cfg.noisyFrac * span()) {
    _partialFlagged = true;
    if (n < max) { BeamEvent& e = out[n++]; memset(&e, 0, sizeof(e)); e.type = BEAM_DRIFT; e.t = s.t; e.drift = DRIFT_PARTIAL; e.estimate = est; e.sd = sd; e.calibrated = _lv.clear; }
  }
}
