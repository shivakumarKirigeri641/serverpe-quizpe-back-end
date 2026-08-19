-- 001_quiz_slots.sql
-- Multiple quizzes per day: add a per-day "slot" (1st / 2nd / 3rd quiz) to each
-- tracker. Free trial & premium get 2 slots/day per subject; premium gets a 3rd
-- on weekends. Existing rows all become slot 1 — identical to today's behaviour.
--
-- SAFE FOR LIVE: only adds a column (default 1) and widens the unique key. No
-- data is rewritten; the slot-1 path is byte-for-byte unchanged.

ALTER TABLE quizpe_tracker
  ADD COLUMN IF NOT EXISTS quiz_slot smallint NOT NULL DEFAULT 1;

ALTER TABLE quizpe_tracker
  DROP CONSTRAINT IF EXISTS tracker_quiz_slot_range;
ALTER TABLE quizpe_tracker
  ADD CONSTRAINT tracker_quiz_slot_range CHECK (quiz_slot BETWEEN 1 AND 3);

-- Widen the daily-uniqueness to include the slot, so a subject can have more
-- than one quiz in a day (one row per slot).
ALTER TABLE quizpe_tracker
  DROP CONSTRAINT IF EXISTS tracker_unique_student_subject_day;
ALTER TABLE quizpe_tracker
  DROP CONSTRAINT IF EXISTS tracker_unique_student_subject_day_slot;
ALTER TABLE quizpe_tracker
  ADD CONSTRAINT tracker_unique_student_subject_day_slot
  UNIQUE (student_id, subject_id, quiz_date, quiz_slot);

CREATE INDEX IF NOT EXISTS idx_tracker_student_day_slot
  ON quizpe_tracker (student_id, quiz_date, quiz_slot);
