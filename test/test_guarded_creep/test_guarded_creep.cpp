#include <unity.h>
#include <GuardedCreep.h>

static CreepRequest req(bool fwd, CreepEvent a, CreepEvent b = (CreepEvent)0, unsigned long maxMs = 8000, unsigned long afterMs = 0) {
  CreepRequest r; r.valid = true; r.forward = fwd; r.until[0] = a; r.nUntil = 1;
  if (b) { r.until[1] = b; r.nUntil = 2; }
  r.maxMs = maxMs; r.afterMs = afterMs; r.id = 7;
  return r;
}

void test_refusals_in_order(void) {
  GuardedCreep c(0.1f);
  CreepRequest bad; bad.valid = false;
  TEST_ASSERT_EQUAL_STRING("no sensor connected", c.start(0, bad, false, false, true, true).error);
  TEST_ASSERT_EQUAL_STRING("bad creep arguments", c.start(0, bad, true, false, true, true).error);
  CreepRequest r = req(true, CREEP_EV_BREAK);
  TEST_ASSERT_EQUAL_STRING("calibrate the sensor first", c.start(0, r, true, false, true, true).error);
  TEST_ASSERT_EQUAL_STRING("calibration is running", c.start(0, r, true, true, true, true).error);
  TEST_ASSERT_EQUAL_STRING("stop the train first", c.start(0, r, true, true, false, true).error);
  TEST_ASSERT_NULL(c.start(0, r, true, true, false, false).error);
  TEST_ASSERT_EQUAL_STRING("a creep is already running", c.start(10, r, true, true, false, false).error);
}

void test_starts_at_creep_speed(void) {
  GuardedCreep c(0.1f);
  CreepOutput o = c.start(0, req(false, CREEP_EV_RESTORE), true, true, false, false);
  TEST_ASSERT_TRUE(o.started); TEST_ASSERT_TRUE(o.motor);
  TEST_ASSERT_EQUAL_FLOAT(0.1f, o.speed); TEST_ASSERT_FALSE(o.forward);
  TEST_ASSERT_TRUE(c.running()); TEST_ASSERT_EQUAL(7, c.id()); TEST_ASSERT_FALSE(c.forward());
}

void test_speed_is_capped(void) {
  GuardedCreep c(0.5f);
  TEST_ASSERT_EQUAL_FLOAT(0.15f, c.start(0, req(true, CREEP_EV_BREAK), true, true, false, false).speed);
}

void test_stops_on_a_single_event(void) {
  GuardedCreep c(0.1f);
  c.start(0, req(true, CREEP_EV_BREAK), true, true, false, false);
  TEST_ASSERT_FALSE(c.onBeam(500, CREEP_EV_RESTORE).ended);
  CreepOutput o = c.onBeam(1000, CREEP_EV_BREAK);
  TEST_ASSERT_TRUE(o.ended); TEST_ASSERT_EQUAL(CREEP_EVENT, o.result);
  TEST_ASSERT_TRUE(o.motor); TEST_ASSERT_EQUAL_FLOAT(0.0f, o.speed);
  TEST_ASSERT_FALSE(c.running());
}

void test_waits_for_both_events_in_order(void) {
  GuardedCreep c(0.1f);
  c.start(0, req(false, CREEP_EV_BREAK, CREEP_EV_RESTORE), true, true, false, false);
  TEST_ASSERT_FALSE(c.onBeam(100, CREEP_EV_RESTORE).ended);
  TEST_ASSERT_FALSE(c.onBeam(200, CREEP_EV_BREAK).ended);
  TEST_ASSERT_TRUE(c.onBeam(900, CREEP_EV_RESTORE).ended);
}

void test_after_ms_keeps_creeping(void) {
  GuardedCreep c(0.1f);
  c.start(0, req(false, CREEP_EV_RESTORE, (CreepEvent)0, 8000, 450), true, true, false, false);
  TEST_ASSERT_FALSE(c.onBeam(1000, CREEP_EV_RESTORE).ended);
  TEST_ASSERT_FALSE(c.tick(1449).ended);
  CreepOutput o = c.tick(1450);
  TEST_ASSERT_TRUE(o.ended); TEST_ASSERT_EQUAL(CREEP_EVENT, o.result); TEST_ASSERT_EQUAL_FLOAT(0.0f, o.speed);
}

void test_times_out(void) {
  GuardedCreep c(0.1f);
  c.start(0, req(true, CREEP_EV_BREAK, (CreepEvent)0, 5000), true, true, false, false);
  TEST_ASSERT_FALSE(c.tick(4999).ended);
  CreepOutput o = c.tick(5000);
  TEST_ASSERT_TRUE(o.ended); TEST_ASSERT_EQUAL(CREEP_TIMEOUT, o.result); TEST_ASSERT_EQUAL_FLOAT(0.0f, o.speed);
}

void test_after_ms_past_the_limit_is_capped(void) {
  GuardedCreep c(0.1f);
  c.start(0, req(true, CREEP_EV_BREAK, (CreepEvent)0, 5000, 1000), true, true, false, false);
  c.onBeam(4900, CREEP_EV_BREAK);
  TEST_ASSERT_FALSE(c.tick(5000).ended);   // the event came in time: let it finish
  CreepOutput o = c.tick(5900);
  TEST_ASSERT_TRUE(o.ended); TEST_ASSERT_EQUAL(CREEP_EVENT, o.result);
  GuardedCreep d(0.1f);
  d.start(0, req(true, CREEP_EV_BREAK, (CreepEvent)0, 5000, 1000), true, true, false, false);
  d.onBeam(4999, CREEP_EV_BREAK);
  TEST_ASSERT_TRUE(d.tick(6000).ended);    // never past maxMs + 1000
}

void test_abort_stops(void) {
  GuardedCreep c(0.1f);
  TEST_ASSERT_FALSE(c.abort("stopped").ended);
  c.start(0, req(true, CREEP_EV_BREAK), true, true, false, false);
  CreepOutput o = c.abort("stopped");
  TEST_ASSERT_TRUE(o.ended); TEST_ASSERT_EQUAL(CREEP_ABORTED, o.result);
  TEST_ASSERT_EQUAL_STRING("stopped", o.detail); TEST_ASSERT_EQUAL_FLOAT(0.0f, o.speed);
  TEST_ASSERT_FALSE(c.running());
}

static Parked endOn(bool fwd, CreepEvent e, unsigned long afterMs = 0) {
  GuardedCreep c(0.1f);
  c.start(0, req(fwd, e, (CreepEvent)0, 8000, afterMs), true, true, false, false);
  c.onBeam(100, e); c.tick(100 + afterMs);
  return c.parked();
}

void test_parked_rules(void) {
  TEST_ASSERT_EQUAL(PARKED_NOSE, endOn(true, CREEP_EV_BREAK));
  TEST_ASSERT_EQUAL(PARKED_NOSE, endOn(false, CREEP_EV_RESTORE));
  TEST_ASSERT_EQUAL(PARKED_TAIL, endOn(false, CREEP_EV_BREAK));
  TEST_ASSERT_EQUAL(PARKED_TAIL, endOn(true, CREEP_EV_RESTORE));
  TEST_ASSERT_EQUAL(PARKED_NONE, endOn(true, CREEP_EV_BREAK, 450));
  GuardedCreep t(0.1f);
  t.start(0, req(true, CREEP_EV_BREAK, (CreepEvent)0, 1000), true, true, false, false);
  t.tick(1000);
  TEST_ASSERT_EQUAL(PARKED_NONE, t.parked());
  TEST_ASSERT_EQUAL_STRING("nose", GuardedCreep::parkedName(PARKED_NOSE));
  TEST_ASSERT_EQUAL_STRING("tail", GuardedCreep::parkedName(PARKED_TAIL));
  TEST_ASSERT_NULL(GuardedCreep::parkedName(PARKED_NONE));
  TEST_ASSERT_EQUAL_STRING("timeout", GuardedCreep::resultName(CREEP_TIMEOUT));
}

void test_parked_cleared_by_idle_beam_event_and_clear(void) {
  GuardedCreep c(0.1f);
  c.start(0, req(true, CREEP_EV_BREAK), true, true, false, false); c.onBeam(100, CREEP_EV_BREAK);
  TEST_ASSERT_EQUAL(PARKED_NOSE, c.parked());
  c.onBeam(5000, CREEP_EV_RESTORE);
  TEST_ASSERT_EQUAL(PARKED_NONE, c.parked());
  c.start(6000, req(true, CREEP_EV_BREAK), true, true, false, false); c.onBeam(6100, CREEP_EV_BREAK);
  c.clearParked();
  TEST_ASSERT_EQUAL(PARKED_NONE, c.parked());
}

void test_events_after_the_end_are_ignored(void) {
  GuardedCreep c(0.1f);
  c.start(0, req(true, CREEP_EV_BREAK, (CreepEvent)0, 1000), true, true, false, false);
  c.tick(1000);
  CreepOutput o = c.onBeam(1100, CREEP_EV_BREAK);
  TEST_ASSERT_FALSE(o.ended); TEST_ASSERT_FALSE(o.motor);
  TEST_ASSERT_EQUAL(PARKED_NONE, c.parked());
}

void test_a_new_creep_clears_parked(void) {
  GuardedCreep c(0.1f);
  c.start(0, req(true, CREEP_EV_BREAK), true, true, false, false); c.onBeam(100, CREEP_EV_BREAK);
  c.start(2000, req(true, CREEP_EV_RESTORE), true, true, false, false);
  TEST_ASSERT_EQUAL(PARKED_NONE, c.parked());
}

int main(int argc, char** argv) {
  UNITY_BEGIN();
  RUN_TEST(test_refusals_in_order);
  RUN_TEST(test_starts_at_creep_speed);
  RUN_TEST(test_speed_is_capped);
  RUN_TEST(test_stops_on_a_single_event);
  RUN_TEST(test_waits_for_both_events_in_order);
  RUN_TEST(test_after_ms_keeps_creeping);
  RUN_TEST(test_times_out);
  RUN_TEST(test_after_ms_past_the_limit_is_capped);
  RUN_TEST(test_abort_stops);
  RUN_TEST(test_parked_rules);
  RUN_TEST(test_parked_cleared_by_idle_beam_event_and_clear);
  RUN_TEST(test_events_after_the_end_are_ignored);
  RUN_TEST(test_a_new_creep_clears_parked);
  return UNITY_END();
}
