#include <unity.h>
#include <BeamCalibration.h>
#include <string.h>

static Stats st(int median) { Stats s; s.n = 150; s.median = median; s.mean = median; s.sd = 3; s.min = median - 6; s.max = median + 6; return s; }

void test_refusals(void) {
  BeamCalibration c(0.1f);
  TEST_ASSERT_EQUAL_STRING("no sensor connected", c.start(0, false, false).error);
  TEST_ASSERT_EQUAL_STRING("stop the train first", c.start(0, true, true).error);
  TEST_ASSERT_NULL(c.start(0, true, false).error);
  TEST_ASSERT_EQUAL_STRING("already calibrating", c.start(10, true, false).error);
}

void test_full_run_out_of_the_beam(void) {
  BeamCalibration c(0.1f);
  CalOutput o = c.start(0, true, false);
  TEST_ASSERT_TRUE(o.sendMeasure);
  TEST_ASSERT_EQUAL_STRING("measuring", c.phaseName());
  o = c.onMeasured(3000, st(747));
  TEST_ASSERT_TRUE(o.motor); TEST_ASSERT_TRUE(o.forward);
  TEST_ASSERT_EQUAL_FLOAT(0.1f, o.speed);
  TEST_ASSERT_TRUE(o.sendWatch); TEST_ASSERT_EQUAL(747, o.watchFrom);
  TEST_ASSERT_EQUAL_STRING("creeping", c.phaseName());
  o = c.tick(5000);
  TEST_ASSERT_FALSE(o.motor);
  o = c.onChanged(6000);
  TEST_ASSERT_TRUE(o.motor); TEST_ASSERT_EQUAL_FLOAT(0.0f, o.speed);
  TEST_ASSERT_TRUE(o.sendWatchOff);
  TEST_ASSERT_FALSE(c.tick(6400).sendMeasure);
  o = c.tick(6500);
  TEST_ASSERT_TRUE(o.sendMeasure);
  TEST_ASSERT_EQUAL_STRING("measuring_second", c.phaseName());
  o = c.onMeasured(9500, st(235));
  TEST_ASSERT_TRUE(o.sendLevels);
  TEST_ASSERT_EQUAL(747, c.a().median);
  TEST_ASSERT_EQUAL(235, c.b().median);
  o = c.onResult(true, nullptr);
  TEST_ASSERT_EQUAL_STRING("done", c.phaseName());
  TEST_ASSERT_FALSE(c.running());
}

void test_forward_timeout_pauses_then_reverses(void) {
  BeamCalibration c(0.1f);
  c.start(0, true, false); c.onMeasured(3000, st(747));
  CalOutput o = c.tick(13000);
  TEST_ASSERT_TRUE(o.motor); TEST_ASSERT_EQUAL_FLOAT(0.0f, o.speed);
  TEST_ASSERT_FALSE(c.tick(13400).motor);
  o = c.tick(13500);
  TEST_ASSERT_TRUE(o.motor); TEST_ASSERT_FALSE(o.forward);
  TEST_ASSERT_EQUAL_FLOAT(0.1f, o.speed);
  TEST_ASSERT_EQUAL_STRING("creeping", c.phaseName());
  o = c.onChanged(20000);
  TEST_ASSERT_EQUAL_FLOAT(0.0f, o.speed);
}

void test_reverse_timeout_gives_up_with_motor_stopped(void) {
  BeamCalibration c(0.1f);
  c.start(0, true, false); c.onMeasured(3000, st(747));
  c.tick(13000); c.tick(13500);
  CalOutput o = c.tick(33500);
  TEST_ASSERT_TRUE(o.motor); TEST_ASSERT_EQUAL_FLOAT(0.0f, o.speed);
  TEST_ASSERT_TRUE(o.sendWatchOff);
  TEST_ASSERT_EQUAL_STRING("failed", c.phaseName());
  TEST_ASSERT_NOT_NULL(strstr(c.detail(), "never changed"));
}

void test_abort_in_every_running_phase_stops_the_motor(void) {
  for (int phase = 0; phase < 5; phase++) {
    BeamCalibration c(0.1f);
    c.start(0, true, false);
    if (phase >= 1) c.onMeasured(3000, st(747));             // creeping
    if (phase >= 2) c.tick(13000);                            // pause
    if (phase >= 3) c.tick(13500);                            // reverse
    if (phase >= 4) { c.onChanged(14000); c.tick(14500); }    // measuring second
    CalOutput o = c.abort("stopped");
    TEST_ASSERT_TRUE(o.motor);
    TEST_ASSERT_EQUAL_FLOAT(0.0f, o.speed);
    TEST_ASSERT_EQUAL_STRING("failed", c.phaseName());
    TEST_ASSERT_EQUAL_STRING("stopped", c.detail());
    TEST_ASSERT_FALSE(c.running());
  }
}

void test_abort_when_idle_does_nothing(void) {
  BeamCalibration c(0.1f);
  TEST_ASSERT_FALSE(c.abort("stopped").motor);
  TEST_ASSERT_EQUAL_STRING("idle", c.phaseName());
}

void test_sensor_silence_while_measuring_fails(void) {
  BeamCalibration c(0.1f);
  c.start(0, true, false);
  TEST_ASSERT_FALSE(c.tick(5999).phaseChanged);
  c.tick(6000);
  TEST_ASSERT_EQUAL_STRING("failed", c.phaseName());
}

void test_a_failed_result_is_reported(void) {
  BeamCalibration c(0.1f);
  c.start(0, true, false); c.onMeasured(3000, st(747)); c.onChanged(4000); c.tick(4500); c.onMeasured(7500, st(720));
  c.onResult(false, "only 27 counts apart");
  TEST_ASSERT_EQUAL_STRING("failed", c.phaseName());
  TEST_ASSERT_EQUAL_STRING("only 27 counts apart", c.detail());
}

void test_stray_events_out_of_phase_are_ignored(void) {
  BeamCalibration c(0.1f);
  TEST_ASSERT_FALSE(c.onChanged(10).motor);
  TEST_ASSERT_FALSE(c.onMeasured(10, st(700)).motor);
  c.start(0, true, false);
  TEST_ASSERT_FALSE(c.onChanged(100).motor);
  TEST_ASSERT_EQUAL_STRING("measuring", c.phaseName());
}

void test_speed_is_capped(void) {
  BeamCalibration c(0.5f);
  c.start(0, true, false);
  TEST_ASSERT_EQUAL_FLOAT(0.15f, c.onMeasured(3000, st(747)).speed);
}

void test_can_run_again_after_finishing(void) {
  BeamCalibration c(0.1f);
  c.start(0, true, false); c.abort("stopped");
  TEST_ASSERT_NULL(c.start(100, true, false).error);
}

int main(int argc, char** argv) {
  UNITY_BEGIN();
  RUN_TEST(test_refusals);
  RUN_TEST(test_full_run_out_of_the_beam);
  RUN_TEST(test_forward_timeout_pauses_then_reverses);
  RUN_TEST(test_reverse_timeout_gives_up_with_motor_stopped);
  RUN_TEST(test_abort_in_every_running_phase_stops_the_motor);
  RUN_TEST(test_abort_when_idle_does_nothing);
  RUN_TEST(test_sensor_silence_while_measuring_fails);
  RUN_TEST(test_a_failed_result_is_reported);
  RUN_TEST(test_stray_events_out_of_phase_are_ignored);
  RUN_TEST(test_speed_is_capped);
  RUN_TEST(test_can_run_again_after_finishing);
  return UNITY_END();
}
