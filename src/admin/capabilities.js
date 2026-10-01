/**
 * src/admin/capabilities.js
 * ---------------------------------------------------------------------------
 * What a signed-in admin is allowed to do.
 *
 * Guard by CAPABILITY, never by role name. "Is this person a super admin?"
 * scattered through a hundred routes is how a panel ends up with two dozen
 * inconsistent answers to the same question; "may this person send a
 * broadcast?" has exactly one.
 *
 * ROLLED OUT LOG-ONLY FIRST. `requireCap` refuses nothing until
 * ADMIN_CAPS_ENFORCE=1. Until then it writes a line saying what it WOULD have
 * refused, so the real access pattern can be read off the logs of a working
 * panel instead of guessed. That is how the WhatsApp webhook signature was
 * rolled out here, and for the same reason: getting this wrong locks the
 * founder out of his own business at eight in the evening.
 *
 * The founder (first entry of ADMIN_MOBILES) and anyone with `is_super` hold
 * every capability, always. There must be no combination of database state
 * that shuts out the person who owns the business.
 * ---------------------------------------------------------------------------
 */

/** Every capability the panel knows about. The navigation declares these too. */
const ALL = [
  'dashboard.view',
  'analytics.view',
  'quiz.manage',
  'questions.view',
  'parents.view',
  'whatsapp.view',
  'whatsapp.send',
  'finance.view',
  'reports.view',
  'support.view',
  'settings.view',
  'admins.manage',
  'data.danger',
];

/**
 * What an ordinary (non-super) admin gets: everything that only reads, plus
 * day-to-day quiz operation. Deliberately withheld — sending to customers,
 * changing settings, managing other admins, and anything destructive.
 */
const STANDARD = [
  'dashboard.view',
  'analytics.view',
  'quiz.manage',
  'questions.view',
  'parents.view',
  'whatsapp.view',
  'reports.view',
  'support.view',
];

const ENFORCE = process.env.ADMIN_CAPS_ENFORCE === '1';

/** The capabilities this admin holds. Super admins hold all of them. */
function forAdmin({ isSuper = false } = {}) {
  return isSuper ? [...ALL] : [...STANDARD];
}

const holds = (can, cap) => Array.isArray(can) && can.includes(cap);

/**
 * Express guard, mounted AFTER requireAdmin — which is what actually
 * authenticates:
 *
 *   router.post('/broadcast', requireAdmin, requireCap('whatsapp.send'), handler)
 *
 * While ADMIN_CAPS_ENFORCE is off this only reports, so adding it to a route
 * cannot break that route.
 */
function requireCap(cap) {
  return (req, res, next) => {
    const can = req.admin?.can || forAdmin({ isSuper: !!req.admin?.super });
    if (holds(can, cap)) return next();

    if (!ENFORCE) {
      console.warn(`[caps] would refuse ${req.admin?.sub || 'unknown'} -> ${cap} (${req.method} ${req.originalUrl})`);
      return next();
    }
    return res.status(403).json({ success: false, error: 'You do not have access to this.' });
  };
}

module.exports = { ALL, STANDARD, forAdmin, holds, requireCap, ENFORCE };
