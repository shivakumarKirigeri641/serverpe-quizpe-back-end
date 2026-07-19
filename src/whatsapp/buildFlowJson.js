/**
 * src/whatsapp/buildFlowJson.js
 * ---------------------------------------------------------------------------
 * Generates the WhatsApp Flow JSON for the signup form, using live DB data for
 * the dropdowns (boards / mediums / grades / states).
 *
 *   node src/whatsapp/buildFlowJson.js  >  quizpe-signup-flow.json
 *
 * This is a STATIC flow (no data_exchange endpoint), so it needs no RSA keys
 * and no encryption: the options are baked into the JSON and the whole form is
 * returned in one `nfm_reply` when the parent taps Submit.
 *
 * Trade-off: dropdown options are frozen at publish time, so re-publish the
 * flow whenever you activate a new board, medium or grade.
 * ---------------------------------------------------------------------------
 */

const db = require('../database/connectDB');

async function build() {
  const boards = (await db.query(
    `SELECT board_code, board_name FROM boards WHERE is_active ORDER BY display_order`)).rows;
  const mediums = (await db.query(
    `SELECT medium_code, medium_name, native_name FROM mediums WHERE is_active ORDER BY display_order`)).rows;
  const grades = (await db.query(
    `SELECT grade_code, grade_name FROM grades WHERE is_active ORDER BY display_order`)).rows;
  const states = (await db.query(
    `SELECT state_code, state_name FROM states_unions WHERE is_active ORDER BY state_name`)).rows;
  const pol = (await db.query(
    `SELECT url FROM policies WHERE policy_code='trial_conditions' AND is_active ORDER BY id DESC LIMIT 1`)).rows[0];

  const opt = (id, title) => ({ id, title });

  return {
    version: '7.0',
    screens: [{
      id: 'SIGNUP',
      title: 'Start Free Trial',
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [{
          type: 'Form',
          name: 'signup_form',
          children: [
            { type: 'TextHeading', text: 'Set up your free trial' },
            { type: 'TextBody', text: 'Just a few details and your child\'s daily quiz starts tonight at 8 PM.' },

            { type: 'TextInput', name: 'student_name', label: 'Child\'s name',
              'input-type': 'text', required: true, 'helper-text': 'As it should appear on the report card' },

            { type: 'Dropdown', name: 'board', label: 'Board', required: true,
              'data-source': boards.map(b => opt(b.board_code, b.board_code)) },

            { type: 'Dropdown', name: 'medium', label: 'Medium of instruction', required: true,
              'data-source': mediums.map(m => opt(m.medium_code, m.native_name || m.medium_name)) },

            { type: 'Dropdown', name: 'grade', label: 'Grade', required: true,
              'data-source': grades.map(g => opt(g.grade_code, g.grade_name)) },

            { type: 'Dropdown', name: 'state', label: 'State / UT', required: true,
              'data-source': states.map(s => opt(s.state_code, s.state_name)) },

            { type: 'OptIn', name: 'accept_terms', required: true,
              label: 'I am the parent/guardian and accept the Terms',
              'on-click-action': { name: 'open_url', url: pol?.url || 'https://quizpe.in/trial-terms' } },

            { type: 'Footer', label: 'Start Free Trial',
              'on-click-action': {
                name: 'complete',
                payload: {
                  student_name: '${form.student_name}',
                  board: '${form.board}',
                  medium: '${form.medium}',
                  grade: '${form.grade}',
                  state: '${form.state}',
                  accept_terms: '${form.accept_terms}',
                },
              } },
          ],
        }],
      },
    }],
  };
}

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const out = path.join(process.cwd(), 'quizpe-signup-flow.json');
  build()
    .then(j => {
      fs.writeFileSync(out, JSON.stringify(j, null, 2));
      console.log(`Flow JSON written to ${out}`);
      return db.close();
    })
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = { build };
