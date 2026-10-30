// friendly_errors.js — the words the app shows when the server says no.
// The server still says "invite code" in two messages (server.js is protected;
// fix the wording server-side at the next server deploy — until then the app
// translates). Pure + executed by test_onboarding_honesty.js.
'use strict';

const BETA_NOT_VALID = 'Beta code not valid.';
const BETA_USED = 'Beta code already used.';

function friendlyServerError(msg) {
  const m = typeof msg === 'string' ? msg : '';
  if (/valid invite code is required/i.test(m)) return BETA_NOT_VALID;
  if (/invite code has already been used/i.test(m)) return BETA_USED;
  return m.replace(/invite code/gi, (w) => (w[0] === 'I' ? 'Beta code' : 'beta code'));
}

module.exports = { friendlyServerError, BETA_NOT_VALID, BETA_USED };
