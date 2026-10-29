'use strict';
// Guards that the three copies of the session-id → filename rule stay identical:
// hooks/lib/state.js sanitizeSessionId, hooks/lib/health.js sanitizeId (via beaconPath),
// tools/companion/controller.cjs sanitizeSessionIdForState. If they diverge the controller
// cannot find the hook's state file for ids that need rewriting.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// controller.cjs pins its log/tmp paths at require time; keep them out of the user's real ~/.zcode.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-sanitize-'));
process.env.ZCODE_ADVISOR_COMPANION_LOG = path.join(TMP, 'companion.log');
process.env.ZCODE_ADVISOR_COMPANION_TMP = TMP;
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const state = require('../hooks/lib/state.js');
const health = require('../hooks/lib/health.js');
const controller = require('../tools/companion/controller.cjs');

const ctlSanitize = controller._internal.sanitizeSessionIdForState;
const healthSanitize = (id) => path.basename(health.beaconPath('/x', id)).replace(/^advisor-health-/, '').replace(/\.json$/, '');

const IDS = [
  'sess_abc-123',            // clean
  'a'.repeat(80),            // clean, at limit
  'a'.repeat(81),            // truncated
  'a/b', 'a.b', 'a b',       // collide under the old rule
  '  padded  ',
  '会话-中文',
  '',
  null,
];

test('controller / state / health compute the same filename for every id', () => {
  for (const id of IDS) {
    const s = state.sanitizeSessionId(id);
    assert.strictEqual(ctlSanitize(id), s, `controller differs for ${JSON.stringify(id)}`);
    assert.strictEqual(healthSanitize(id), s, `health differs for ${JSON.stringify(id)}`);
  }
});

test('clean ids keep their filename; rewritten ids no longer collide', () => {
  assert.strictEqual(state.sanitizeSessionId('sess_abc-123'), 'sess_abc-123');
  assert.strictEqual(state.sanitizeSessionId(''), 'default');
  const outs = ['a/b', 'a.b', 'a b'].map(state.sanitizeSessionId);
  assert.strictEqual(new Set(outs).size, 3);
  for (const o of outs) assert.match(o, /^[A-Za-z0-9_-]{1,80}$/);
  assert.ok(state.sanitizeSessionId('a'.repeat(200)).length <= 80);
});
