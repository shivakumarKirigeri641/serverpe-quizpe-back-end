/**
 * src/admin/quizLive.js
 * ---------------------------------------------------------------------------
 * What is happening in tonight's quiz, right now — the numbers behind the
 * dials, gauges and live plots on the admin panel.
 *
 * NO NEW TABLES WERE NEEDED FOR ANY OF THIS. `student_quizpe_histories`
 * already records, per question: when it was sent, when it was answered, which
 * option was chosen, whether that was right, and how many seconds it took.
 * That is the complete live timeline, already being written by the quiz itself
 * on its own hot path. Adding a parallel events table would have meant a
 * second write during every child's quiz to record what the first write
 * already knew.
 *
 * Every query here runs through ./readOnly, so the database refuses writes
 * from this module rather than trusting it not to make any.
 *
 * Shaped to the indexes that already exist — idx_tracker_date,
 * idx_tracker_student_day_slot, idx_sqh_tracker, idx_sqh_question. No index is
 * added and no table is touched that the quiz does not already read.
 * ---------------------------------------------------------------------------
 */

const { read, TZ, TODAY } = require('./readOnly');

/* ────────────────────────────────────────────────────────────────────────────
 * 1. The pulse: one row of headline numbers for the dials.
 * ──────────────────────────────────────────────────────────────────────────*/
async function pulse() {
  const rows = await read(
    `WITH t AS (
       SELECT id, question_count, quiz_slot
         FROM quizpe_tracker
        WHERE quiz_date = ${TODAY} AND is_active AND NOT is_instant
     ),
     h AS (
       SELECT h.tracker_id,
              count(*) FILTER (WHERE h.sent_at     IS NOT NULL) AS sent,
              count(*) FILTER (WHERE h.answered_at IS NOT NULL) AS answered,
              count(*) FILTER (WHERE h.is_correct)              AS correct,
              max(h.answered_at)                                AS last_answer,
              avg(h.response_seconds) FILTER (WHERE h.response_seconds IS NOT NULL) AS avg_secs
         FROM student_quizpe_histories h
         JOIN t ON t.id = h.tracker_id
        GROUP BY h.tracker_id
     )
     SELECT (SELECT count(*) FROM t)::int                               AS quizzes_today,
            COALESCE(sum(h.sent), 0)::int                               AS questions_sent,
            COALESCE(sum(h.answered), 0)::int                           AS questions_answered,
            COALESCE(sum(h.correct), 0)::int                            AS questions_correct,
            count(*) FILTER (WHERE h.answered > 0)::int                 AS started,
            count(*) FILTER (WHERE h.answered >= t.question_count)::int AS completed,
            count(*) FILTER (
              WHERE h.answered > 0 AND h.answered < t.question_count
                AND h.last_answer > now() - interval '30 minutes')::int  AS in_progress,
            count(*) FILTER (
              WHERE h.answered > 0 AND h.answered < t.question_count
                AND h.last_answer <= now() - interval '30 minutes')::int AS stalled,
            ROUND(AVG(h.avg_secs)::numeric, 1)                           AS avg_response_seconds
       FROM t LEFT JOIN h ON h.tracker_id = t.id`);

  const r = rows[0] || {};
  const answered = Number(r.questions_answered || 0);
  return {
    ...r,
    accuracy_pct: answered ? Math.round((Number(r.questions_correct) / answered) * 1000) / 10 : null,
    completion_pct: r.quizzes_today
      ? Math.round((Number(r.completed) / Number(r.quizzes_today)) * 1000) / 10 : null,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Answers per minute — the live plot's series.
 * ──────────────────────────────────────────────────────────────────────────*/
async function minuteSeries(minutes = 120) {
  const mins = Math.min(Math.max(Number(minutes) || 120, 10), 360);
  return read(
    `WITH span AS (
       SELECT generate_series(
         date_trunc('minute', now()) - make_interval(mins => $1::int),
         date_trunc('minute', now()),
         interval '1 minute') AS minute
     ),
     a AS (
       SELECT date_trunc('minute', h.answered_at)      AS minute,
              count(*)::int                            AS answers,
              count(*) FILTER (WHERE h.is_correct)::int AS correct
         FROM student_quizpe_histories h
         JOIN quizpe_tracker t ON t.id = h.tracker_id
        WHERE t.quiz_date = ${TODAY} AND t.is_active
          AND h.answered_at >= now() - make_interval(mins => $1::int)
        GROUP BY 1
     )
     SELECT to_char(span.minute AT TIME ZONE '${TZ}', 'HH24:MI') AS at,
            COALESCE(a.answers, 0) AS answers,
            COALESCE(a.correct, 0) AS correct
       FROM span LEFT JOIN a ON a.minute = span.minute
      ORDER BY span.minute`,
    [mins]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Per slot: built → sent → started → completed.
 * ──────────────────────────────────────────────────────────────────────────*/
async function slotFunnel() {
  return read(
    `WITH t AS (
       SELECT id, quiz_slot, question_count
         FROM quizpe_tracker
        WHERE quiz_date = ${TODAY} AND is_active AND NOT is_instant
     ),
     h AS (
       SELECT h.tracker_id,
              count(*) FILTER (WHERE h.sent_at     IS NOT NULL) AS sent,
              count(*) FILTER (WHERE h.answered_at IS NOT NULL) AS answered
         FROM student_quizpe_histories h
         JOIN t ON t.id = h.tracker_id
        GROUP BY h.tracker_id
     )
     SELECT t.quiz_slot::int                                         AS slot,
            count(*)::int                                            AS built,
            count(*) FILTER (WHERE COALESCE(h.sent, 0)     > 0)::int AS sent,
            count(*) FILTER (WHERE COALESCE(h.answered, 0) > 0)::int AS started,
            count(*) FILTER (WHERE COALESCE(h.answered, 0) >= t.question_count)::int AS completed
       FROM t LEFT JOIN h ON h.tracker_id = t.id
      GROUP BY t.quiz_slot
      ORDER BY t.quiz_slot`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Who is mid-quiz right now, and on which question.
 *
 * This is the Live Quiz Monitor's table. It is built entirely from rows the
 * quiz already writes — no session table, no event stream, no second write.
 * ──────────────────────────────────────────────────────────────────────────*/
async function inFlight({ staleMinutes = 30 } = {}) {
  const stale = Math.min(Math.max(Number(staleMinutes) || 30, 5), 240);
  return read(
    `WITH t AS (
       SELECT id, student_id, subject_id, question_count, quiz_slot, difficulty_level
         FROM quizpe_tracker
        WHERE quiz_date = ${TODAY} AND is_active AND NOT is_instant
     ),
     h AS (
       SELECT h.tracker_id,
              count(*) FILTER (WHERE h.sent_at     IS NOT NULL)::int AS sent,
              count(*) FILTER (WHERE h.answered_at IS NOT NULL)::int AS answered,
              count(*) FILTER (WHERE h.is_correct)::int              AS correct,
              min(h.sent_at)                                         AS first_sent,
              max(h.answered_at)                                     AS last_answer,
              avg(h.response_seconds)                                AS avg_secs
         FROM student_quizpe_histories h
         JOIN t ON t.id = h.tracker_id
        GROUP BY h.tracker_id
     )
     SELECT t.id                          AS tracker_id,
            st.id                         AS student_id,
            st.student_name,
            p.id                          AS parent_id,
            p.parent_mobile_number        AS mobile,
            g.grade_name,
            subj.subject_code,
            t.quiz_slot::int              AS slot,
            t.difficulty_level,
            t.question_count::int         AS total_questions,
            COALESCE(h.sent, 0)           AS sent,
            COALESCE(h.answered, 0)       AS answered,
            COALESCE(h.correct, 0)        AS correct,
            GREATEST(t.question_count - COALESCE(h.answered, 0), 0)::int AS remaining,
            ROUND(COALESCE(h.answered, 0) * 100.0 / NULLIF(t.question_count, 0), 0) AS progress_pct,
            ROUND(h.avg_secs::numeric, 1) AS avg_response_seconds,
            to_char(h.first_sent  AT TIME ZONE '${TZ}', 'HH24:MI') AS started_at,
            to_char(h.last_answer AT TIME ZONE '${TZ}', 'HH24:MI') AS last_activity,
            EXTRACT(EPOCH FROM (now() - h.last_answer))::int        AS idle_seconds,
            CASE
              WHEN COALESCE(h.answered, 0) >= t.question_count            THEN 'completed'
              WHEN COALESCE(h.answered, 0) = 0 AND COALESCE(h.sent, 0) = 0 THEN 'not sent'
              WHEN COALESCE(h.answered, 0) = 0                            THEN 'waiting for first answer'
              WHEN h.last_answer > now() - make_interval(mins => $1::int) THEN 'answering'
              ELSE 'stalled'
            END AS status
       FROM t
       JOIN students st ON st.id = t.student_id
       JOIN parents  p  ON p.id  = st.parent_id
       JOIN grades   g  ON g.id  = st.grade_id
       JOIN subjects subj ON subj.id = t.subject_id
       LEFT JOIN h ON h.tracker_id = t.id
      ORDER BY (COALESCE(h.answered, 0) >= t.question_count),  -- unfinished first
               h.last_answer DESC NULLS LAST`,
    [stale]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. One child's quiz, question by question — the live detail view.
 * ──────────────────────────────────────────────────────────────────────────*/
async function timeline(trackerId) {
  const id = Number(trackerId);
  if (!Number.isFinite(id)) return [];
  return read(
    `SELECT h.serial_number::int AS n,
            h.question_id,
            q.question_whatsapp  AS question_text,
            q.option_a, q.option_b, q.option_c, q.option_d,
            q.answer             AS correct_option,
            q.chapter,
            h.answered_option,
            h.is_correct,
            h.response_seconds,
            to_char(h.sent_at     AT TIME ZONE '${TZ}', 'HH24:MI:SS') AS sent_at,
            to_char(h.answered_at AT TIME ZONE '${TZ}', 'HH24:MI:SS') AS answered_at,
            CASE
              WHEN h.answered_at IS NOT NULL THEN 'answered'
              WHEN h.sent_at     IS NOT NULL THEN 'waiting'
              ELSE 'not sent'
            END AS status
       FROM student_quizpe_histories h
       JOIN question_bank q ON q.id = h.question_id
      WHERE h.tracker_id = $1
      ORDER BY h.serial_number`,
    [id]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6. Which questions are not working.
 *
 * Accuracy alone does not find a broken question — a genuinely hard one also
 * scores low, and hard questions are the point. The tell is a WRONG option
 * that most children converge on: usually a mis-keyed answer or a distractor
 * that is also defensible.
 * ──────────────────────────────────────────────────────────────────────────*/
async function questionAccuracy({ days = 30, limit = 40, minAttempts = 5 } = {}) {
  const d = Math.min(Math.max(Number(days) || 30, 1), 180);
  const lim = Math.min(Math.max(Number(limit) || 40, 1), 200);
  const min = Math.max(Number(minAttempts) || 5, 1);

  return read(
    `WITH ans AS (
       SELECT h.question_id, h.answered_option, h.is_correct, h.response_seconds
         FROM student_quizpe_histories h
         JOIN quizpe_tracker t ON t.id = h.tracker_id
        WHERE t.quiz_date >= ${TODAY} - $1::int
          AND h.answered_at IS NOT NULL
     ),
     agg AS (
       SELECT question_id,
              count(*)::int                          AS attempts,
              count(*) FILTER (WHERE is_correct)::int AS correct,
              ROUND(AVG(response_seconds)::numeric, 1) AS avg_seconds
         FROM ans GROUP BY question_id
        HAVING count(*) >= $3::int
     ),
     worst AS (
       SELECT DISTINCT ON (question_id)
              question_id, answered_option AS top_wrong_option, n AS top_wrong_count
         FROM (SELECT question_id, answered_option, count(*)::int AS n
                 FROM ans WHERE NOT is_correct AND answered_option IS NOT NULL
                GROUP BY 1, 2) x
        ORDER BY question_id, n DESC, answered_option
     )
     SELECT agg.question_id, agg.attempts, agg.correct, agg.avg_seconds,
            ROUND(agg.correct * 100.0 / agg.attempts, 1) AS accuracy_pct,
            w.top_wrong_option, w.top_wrong_count,
            ROUND(COALESCE(w.top_wrong_count, 0) * 100.0 / agg.attempts, 1) AS top_wrong_pct,
            q.question_whatsapp AS question_text,
            q.answer            AS correct_option,
            q.difficulty_level, q.chapter
       FROM agg
       LEFT JOIN worst w ON w.question_id = agg.question_id
       JOIN question_bank q ON q.id = agg.question_id
      ORDER BY (agg.correct * 1.0 / agg.attempts) ASC, agg.attempts DESC
      LIMIT $2::int`,
    [d, lim, min]);
}

module.exports = {
  pulse, minuteSeries, slotFunnel, inFlight, timeline, questionAccuracy, read,
};
