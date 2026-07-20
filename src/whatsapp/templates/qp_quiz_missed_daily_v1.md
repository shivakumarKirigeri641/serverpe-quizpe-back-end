# Template: `qp_quiz_missed_daily_v1`

Submit this in **Meta Business Manager → WhatsApp Manager → Message Templates**.

| Field | Value |
| --- | --- |
| Name | `qp_quiz_missed_daily_v1` |
| Category | **UTILITY** |
| Language | English (`en`) |
| Header | TEXT — `Quiz missed: {{1}}` |
| Footer | `QuizPe by ServerPe App Solutions` |
| Buttons | QUICK_REPLY — `▶️ Start Quiz now` · QUICK_REPLY — `⏰ Change quiz time` |

### Header

```
Quiz missed: {{1}}
```

### Body

```
Hello {{2}},

{{1}} did not attempt today's quiz ({{3}}) scheduled at {{4}}.

Subject: {{5}}
Day {{6}} of the plan
Questions waiting: {{7}}
Current streak: {{8}}

Missing a day breaks the daily habit and today's chapter stays unrevised, which makes tomorrow's questions harder. The quiz is still open and takes about 5 minutes.

You can start it now, or change the daily quiz time so it suits your family's routine better.

Thank you,
Team QuizPe
```

### Sample values (for Meta review)

| Var | Meaning | Example |
| --- | --- | --- |
| {{1}} | student_name | Shivam |
| {{2}} | parent_name | Shiv |
| {{3}} | quiz_date | 20 Jul 2026 |
| {{4}} | quiz_time | 8:00 PM |
| {{5}} | subject_name | Mathematics |
| {{6}} | day_number | 3 |
| {{7}} | question_count | 10 |
| {{8}} | streak | 2 days |

---

## Why this should pass review as UTILITY

Meta rejects templates that read as marketing. This one qualifies because it:

- refers to a **specific transaction the user set up** (a scheduled quiz on an active subscription),
- states **factual account information** (date, time, subject, day number, questions pending),
- contains **no offer, discount, price or upsell**,
- gives a **genuine control** ("change quiz time"), not just a conversion path.

Avoid adding any of these, or it will be reclassified as MARKETING and fail:
"Don't miss out", "Hurry", "Upgrade now", "₹99", "limited time", emojis in the body promising rewards.

## Sending rules to apply in code

- **Once per student per day, maximum** — enforce via `notification_log` (`kind = 'quiz_missed'`), the same guard the reminder uses.
- **Never** if the quiz was completed or closed, or if no tracker exists for the day.
- **Never** to a parent who replied STOP (`parents.reminders_enabled = false`).
- Send **well after** `quiz_time` — a 60–90 minute gap is fair, so a parent mid-quiz is not accused of skipping.
- Skip entirely on the parent's first day, when a missed quiz is usually setup confusion rather than a skip.
