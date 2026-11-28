#include <unity.h>
#include <BeamDetector.h>
#include <vector>
#include <string>

struct Sample { double t; int v; };
struct Run { int value; int count; };

// 20 ms samples from [value, count] runs, with the same small deterministic noise as the JS tests
static std::vector<Sample> trace(std::vector<Run> runs, int noise = 2) {
  std::vector<Sample> out; double t = 0; int k = 0;
  for (auto& r : runs) for (int i = 0; i < r.count; i++) { out.push_back({t, r.value + ((k++ * 7) % (2 * noise + 1)) - noise}); t += 20; }
  return out;
}

struct Result { std::vector<BeamEvent> ev; std::string names; };

static Result run(std::vector<Sample> s, BeamLevels lv = {340, 30}) {
  BeamDetector d(lv); Result r; BeamEvent buf[4];
  for (auto& x : s) {
    int n = d.push(x.t, x.v, buf, 4);
    for (int i = 0; i < n; i++) {
      r.ev.push_back(buf[i]);
      static const char* N[] = {"ready", "break", "restore", "pass", "drift"};
      if (!r.names.empty()) r.names += ",";
      r.names += N[buf[i].type];
    }
  }
  return r;
}

static const BeamEvent* find(const Result& r, BeamEventType t) {
  for (auto& e : r.ev) if (e.type == t) return &e;
  return nullptr;
}
static int count(const Result& r, BeamEventType t) { int n = 0; for (auto& e : r.ev) if (e.type == t) n++; return n; }

void test_clean_crossing(void) {
  Result r = run(trace({{340, 60}, {30, 64}, {340, 60}}));
  TEST_ASSERT_EQUAL_STRING("ready,break,restore,pass", r.names.c_str());
  const BeamEvent* p = find(r, BEAM_PASS);
  TEST_ASSERT_TRUE(p->durationMs > 64 * 20 - 60 && p->durationMs < 64 * 20 + 60);
  TEST_ASSERT_TRUE(p->minLevel < 40);
  TEST_ASSERT_TRUE(p->maxLevel < 60);
  TEST_ASSERT_TRUE(p->t1 > p->t0);
}

void test_pass_with_windows_has_high_max(void) {
  Result r = run(trace({{340, 60}, {30, 20}, {260, 4}, {30, 20}, {340, 60}}));
  TEST_ASSERT_TRUE(find(r, BEAM_PASS)->maxLevel > 200);
}

void test_one_stray_low_reading_is_ignored(void) {
  TEST_ASSERT_EQUAL_STRING("ready", run(trace({{340, 40}, {30, 1}, {340, 40}})).names.c_str());
}

void test_noise_does_not_chatter(void) {
  TEST_ASSERT_EQUAL_STRING("ready", run(trace({{340, 300}}, 8)).names.c_str());
}

void test_starting_inside_the_beam(void) {
  Result r = run(trace({{30, 40}, {340, 40}}));
  TEST_ASSERT_TRUE(r.ev[0].blocked);
  TEST_ASSERT_EQUAL_STRING("ready,restore", r.names.c_str());
}

void test_sagging_clear_level_drifts_low_once(void) {
  Result r = run(trace({{340, 20}, {260, 400}}));
  TEST_ASSERT_EQUAL(1, count(r, BEAM_DRIFT));
  TEST_ASSERT_EQUAL(DRIFT_LOW, find(r, BEAM_DRIFT)->drift);
}

void test_half_blocked_is_partial_once_and_parked_is_not(void) {
  Result half = run(trace({{340, 20}, {190, 400}}));
  TEST_ASSERT_EQUAL(1, count(half, BEAM_DRIFT));
  TEST_ASSERT_EQUAL(DRIFT_PARTIAL, find(half, BEAM_DRIFT)->drift);
  TEST_ASSERT_EQUAL(0, count(run(trace({{340, 20}, {30, 400}})), BEAM_DRIFT));
}

void test_shallow_wobble_does_not_break(void) {
  TEST_ASSERT_EQUAL_STRING("ready", run(trace({{340, 30}, {290, 30}, {340, 30}})).names.c_str());
}

void test_state_and_clear_estimate(void) {
  BeamDetector d({340, 30}); BeamEvent b[4];
  TEST_ASSERT_EQUAL_STRING("init", d.state());
  for (auto& s : trace({{330, 50}}, 0)) d.push(s.t, s.v, b, 4);
  TEST_ASSERT_EQUAL_STRING("clear", d.state());
  TEST_ASSERT_EQUAL(330, d.clearEstimate());
}

void test_summarize(void) {
  int v[] = {5, 1, 3, 2, 4};
  Stats s = summarize(v, 5);
  TEST_ASSERT_EQUAL(5, s.n);
  TEST_ASSERT_EQUAL(3, s.median);
  TEST_ASSERT_EQUAL(1, s.min);
  TEST_ASSERT_EQUAL(5, s.max);
  TEST_ASSERT_EQUAL_FLOAT(3.0, s.mean);
}

static Stats flat(int median, double sd = 2) { Stats s; s.n = 150; s.median = median; s.mean = median; s.sd = sd; s.min = median - 5; s.max = median + 5; return s; }

void test_derive_levels_orders_either_way(void) {
  Derived a = deriveLevels(flat(747), flat(235));
  TEST_ASSERT_TRUE(a.ok);
  TEST_ASSERT_EQUAL(747, a.levels.clear);
  TEST_ASSERT_EQUAL(235, a.levels.blocked);
  Derived b = deriveLevels(flat(235), flat(747));
  TEST_ASSERT_TRUE(b.ok);
  TEST_ASSERT_EQUAL(747, b.levels.clear);
  TEST_ASSERT_EQUAL(0, b.nWarnings);
}

void test_derive_levels_refuses_a_small_span(void) {
  Derived d = deriveLevels(flat(700), flat(660));
  TEST_ASSERT_FALSE(d.ok);
  TEST_ASSERT_TRUE(strlen(d.error) > 0);
}

void test_derive_levels_warns_on_noise(void) {
  Derived d = deriveLevels(flat(747, 40), flat(235));
  TEST_ASSERT_TRUE(d.ok);
  TEST_ASSERT_TRUE(d.nWarnings >= 1);
}

void test_change_watch(void) {
  ChangeWatch w;
  w.start(750);
  TEST_ASSERT_FALSE(w.push(745));
  TEST_ASSERT_FALSE(w.push(230));          // one stray sample
  TEST_ASSERT_FALSE(w.push(748));
  TEST_ASSERT_FALSE(w.push(650));          // a 100-count dip is not a change
  TEST_ASSERT_FALSE(w.push(240));
  TEST_ASSERT_TRUE(w.push(232));
  w.start(230);
  TEST_ASSERT_FALSE(w.push(750));
  TEST_ASSERT_TRUE(w.push(752));           // a rise counts too
}

int main(int argc, char** argv) {
  UNITY_BEGIN();
  RUN_TEST(test_clean_crossing);
  RUN_TEST(test_pass_with_windows_has_high_max);
  RUN_TEST(test_one_stray_low_reading_is_ignored);
  RUN_TEST(test_noise_does_not_chatter);
  RUN_TEST(test_starting_inside_the_beam);
  RUN_TEST(test_sagging_clear_level_drifts_low_once);
  RUN_TEST(test_half_blocked_is_partial_once_and_parked_is_not);
  RUN_TEST(test_shallow_wobble_does_not_break);
  RUN_TEST(test_state_and_clear_estimate);
  RUN_TEST(test_summarize);
  RUN_TEST(test_derive_levels_orders_either_way);
  RUN_TEST(test_derive_levels_refuses_a_small_span);
  RUN_TEST(test_derive_levels_warns_on_noise);
  RUN_TEST(test_change_watch);
  return UNITY_END();
}
