/**
 * src/whatsapp/buildQuizFlowJson.js
 * ---------------------------------------------------------------------------
 * Flow JSON for the quiz answer screen — 4 true radio buttons + "Submit & Next".
 *
 *   node src/whatsapp/buildQuizFlowJson.js   ->  quizpe-quiz-flow.json
 *
 * Why this needs NO encrypted endpoint:
 * the screen declares a `data` schema, and each question's text/options are
 * supplied at SEND time in flow_action_payload.data. So the flow stays static
 * (flow_action: "navigate") while the content is fully dynamic — no
 * data_exchange, no RSA/AES key exchange.
 *
 * tracker_id and serial ride along in the data and come back in the completion
 * payload, so the answer can be matched to the exact question.
 * ---------------------------------------------------------------------------
 */

const flow = {
  version: '7.0',
  screens: [{
    id: 'QUESTION',
    title: 'Quiz',
    terminal: true,
    success: true,
    // Values supplied per-question at send time; __example__ is what Meta
    // validates the layout against when the flow is published.
    data: {
      serial:     { type: 'string', __example__: '1' },
      total:      { type: 'string', __example__: '10' },
      chapter:    { type: 'string', __example__: 'Numbers up to 100' },
      question:   { type: 'string', __example__: '4 tens and 8 ones make which number?' },
      tracker_id: { type: 'string', __example__: '1' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, title: { type: 'string' } },
        },
        __example__: [
          { id: 'A', title: 'A)  47' },
          { id: 'B', title: 'B)  48' },
          { id: 'C', title: 'C)  50' },
          { id: 'D', title: 'D)  84' },
        ],
      },
    },
    layout: {
      type: 'SingleColumnLayout',
      children: [
        { type: 'TextHeading', text: 'Question ${data.serial} of ${data.total}' },
        { type: 'TextCaption', text: '${data.chapter}' },
        { type: 'TextBody',    text: '${data.question}' },
        {
          type: 'Form',
          name: 'quiz_form',
          children: [
            {
              type: 'RadioButtonsGroup',
              name: 'answer',
              label: 'Choose your answer',
              required: true,
              'data-source': '${data.options}',
            },
            {
              type: 'Footer',
              label: 'Submit & Next',
              'on-click-action': {
                name: 'complete',
                payload: {
                  answer: '${form.answer}',
                  tracker_id: '${data.tracker_id}',
                  serial: '${data.serial}',
                },
              },
            },
          ],
        },
      ],
    },
  }],
};

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const out = path.join(process.cwd(), 'quizpe-quiz-flow.json');
  fs.writeFileSync(out, JSON.stringify(flow, null, 2));
  console.log(`Quiz Flow JSON written to ${out}`);
}

module.exports = { flow };
