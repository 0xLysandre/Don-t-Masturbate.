'use strict';

const { randomUUID } = require('node:crypto');

const { Store, EXAMPLE_BLOCKLIST, EXAMPLE_KEYWORDS } = require('./store');
const { encrypt, decrypt, generatePassword, safeEqual } = require('./secure');
const { dateKey, currentStreak, longestStreak } = require('./streak');

// Once the cooldown elapses the password stays retrievable for this long, so a
// closed tab or a fumbled copy/paste does not cost another full cooldown.
const REVEAL_WINDOW_MINUTES = 10;

/**
 * How far the blocked-term list reaches, narrowest first.
 *
 *   engines  the four supported search engines only
 *   search   search boxes on any site, plus any site's search-style URL
 *   inputs   as above, and the terms cannot be typed into any text field
 *
 * All three are enforced by content scripts reading page inputs. None of them
 * involve system-wide or OS-level keystroke capture; nothing outside a browser
 * tab is ever observed.
 */
const KEYWORD_SCOPES = ['engines', 'search', 'inputs'];

function fail(message, status = 400, code = 'error') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function cleanList(list) {
  if (!Array.isArray(list)) throw fail('Expected an array.');
  return [...new Set(list.map((v) => String(v).trim().toLowerCase()).filter(Boolean))].sort();
}

/** Normalises first, then de-duplicates, so "https://www.x.com/a" and "x.com" collapse. */
function cleanDomains(list) {
  if (!Array.isArray(list)) throw fail('Expected an array.');
  const domains = list
    .map((value) => String(value).trim())
    .filter(Boolean)
    .map(normaliseDomain);
  return [...new Set(domains)].sort();
}

/** Accepts "example.com", "www.example.com", "https://example.com/path". */
function normaliseDomain(raw) {
  let value = String(raw).trim().toLowerCase();
  if (!value) return '';
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split('/')[0].split('?')[0].split('#')[0];
  value = value.split('@').pop();
  value = value.replace(/:\d+$/, '');
  value = value.replace(/^www\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) throw fail(`"${raw}" is not a valid domain.`);
  return value;
}

/**
 * Everything the extension and the CLI are allowed to do, in one place.
 *
 * The single rule that makes this tool worth anything: while a session is
 * active, any change that would weaken protection (editing the lists, ending
 * the session early) requires the vault password — which the time-lock will
 * not hand over on demand.
 */
class App {
  constructor(store = new Store()) {
    this.store = store;
  }

  get state() {
    return this.store.state;
  }

  save() {
    this.store.save();
  }

  // --------------------------------------------------------------- sessions

  /** Also lazily retires a session whose end time has passed. */
  sessionActive() {
    const session = this.state.session;
    if (!session || !session.active) return false;
    if (session.endsAt && Date.parse(session.endsAt) <= Date.now()) {
      session.active = false;
      session.endedAt = new Date().toISOString();
      session.endedReason = 'expired';
      this.save();
      return false;
    }
    return true;
  }

  verifyPassword(candidate) {
    const secret = this.state.vault && this.state.vault.secret;
    if (!secret || !candidate) return false;
    let plaintext;
    try {
      plaintext = decrypt(secret, this.store.key);
    } catch {
      return false;
    }
    return safeEqual(plaintext, String(candidate));
  }

  /** No-op when unlocked; throws unless the correct password is supplied. */
  requireAuthority(password) {
    if (!this.sessionActive()) return;
    if (!password) {
      throw fail(
        'Protection is active — this change needs the vault password. Request an unlock and wait out the cooldown.',
        403,
        'password_required',
      );
    }
    if (!this.verifyPassword(password)) throw fail('Incorrect password.', 403, 'bad_password');
  }

  // ------------------------------------------------------------------ setup

  setup({ cooldownHours, blocklist, keywords, keywordScope, withExamples = true } = {}) {
    if (this.state.setupComplete && this.sessionActive()) {
      throw fail('Setup has already run and a session is active.', 409, 'already_setup');
    }
    this.state.setupComplete = true;
    this.state.cooldownHours = this.#coerceCooldown(cooldownHours ?? this.state.cooldownHours);
    if (blocklist) this.state.blocklist = cleanDomains(blocklist);
    else if (withExamples && this.state.blocklist.length === 0)
      this.state.blocklist = [...EXAMPLE_BLOCKLIST];
    if (keywordScope !== undefined) this.state.keywordScope = this.#coerceScope(keywordScope);
    if (keywords) this.state.keywords = cleanList(keywords);
    else if (withExamples && this.state.keywords.length === 0)
      this.state.keywords = [...EXAMPLE_KEYWORDS];
    this.#rotatePassword('setup');
    this.save();
    // Deliberately returns no password — the user never sees it at setup.
    return {
      setupComplete: true,
      passwordExists: true,
      cooldownHours: this.state.cooldownHours,
      blocklistCount: this.state.blocklist.length,
      keywordCount: this.state.keywords.length,
      keywordScope: this.state.keywordScope,
    };
  }

  #coerceScope(scope) {
    const value = String(scope).trim().toLowerCase();
    if (!KEYWORD_SCOPES.includes(value)) {
      throw fail(`Term scope must be one of: ${KEYWORD_SCOPES.join(', ')}.`);
    }
    return value;
  }

  #coerceCooldown(hours) {
    const n = Number(hours);
    if (!Number.isFinite(n) || n < 0 || n > 24 * 30) {
      throw fail('Cooldown must be between 0 and 720 hours.');
    }
    return n;
  }

  /**
   * Which password the vault is on. Requests are tagged with it, so a request
   * can never outlive the password it was made against. State written before
   * this field existed reads as generation 0 and is retired by the next
   * rotation.
   */
  #vaultGeneration() {
    return this.state.vault.generation ?? 0;
  }

  #rotatePassword(reason) {
    const now = new Date().toISOString();
    this.state.vault.secret = encrypt(generatePassword(), this.store.key);
    this.state.vault.createdAt = this.state.vault.createdAt || now;
    this.state.vault.rotatedAt = now;
    this.state.vault.rotationReason = reason;
    this.state.vault.generation = this.#vaultGeneration() + 1;

    // Every open request was made against the password that just died —
    // including one already revealed. Leaving a revealed request open would
    // let its copy window carry over to the new password, handing it out with
    // no cooldown at all.
    for (const req of this.state.unlockRequests) {
      if (req.closedAt) continue;
      if (req.status === 'pending' || req.status === 'ready') req.status = 'superseded';
      req.closedAt = now;
      req.closedReason = `Password rotated (${reason}).`;
    }
  }

  // ------------------------------------------------------------------ lists

  getConfig() {
    const active = this.sessionActive();
    return {
      setupComplete: this.state.setupComplete,
      active,
      session: this.state.session,
      cooldownHours: this.state.cooldownHours,
      blocklist: this.state.blocklist,
      keywords: this.state.keywords,
      keywordScope: this.state.keywordScope,
      updatedAt: new Date().toISOString(),
    };
  }

  updateConfig({ blocklist, keywords, keywordScope, cooldownHours, password } = {}) {
    this.requireAuthority(password);
    if (blocklist !== undefined) this.state.blocklist = cleanDomains(blocklist);
    if (keywords !== undefined) this.state.keywords = cleanList(keywords);
    if (keywordScope !== undefined) this.state.keywordScope = this.#coerceScope(keywordScope);
    if (cooldownHours !== undefined) this.state.cooldownHours = this.#coerceCooldown(cooldownHours);
    this.save();
    return this.getConfig();
  }

  // ---------------------------------------------------------- session start

  startSession({ durationHours, password } = {}) {
    if (!this.state.setupComplete) throw fail('Run setup first.', 409, 'not_setup');
    this.requireAuthority(password);
    const hours = Number(durationHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) {
      throw fail('Session duration must be between 0 and 8760 hours.');
    }
    const now = Date.now();
    // A fresh session gets a fresh password: whatever was revealed last time is
    // dead the moment the user commits again.
    this.#rotatePassword('session_start');
    this.state.session = {
      active: true,
      startedAt: new Date(now).toISOString(),
      endsAt: new Date(now + hours * 3600000).toISOString(),
      endedAt: null,
      endedReason: null,
      durationHours: hours,
    };
    this.save();
    return { session: this.state.session, passwordRotated: true };
  }

  stopSession({ password } = {}) {
    if (!this.sessionActive()) return { session: this.state.session, alreadyInactive: true };
    this.requireAuthority(password);
    this.state.session.active = false;
    this.state.session.endedAt = new Date().toISOString();
    this.state.session.endedReason = 'unlocked';
    this.save();
    return { session: this.state.session };
  }

  // ----------------------------------------------------------------- unlock

  #latestOpenRequest() {
    const generation = this.#vaultGeneration();
    for (let i = this.state.unlockRequests.length - 1; i >= 0; i -= 1) {
      const req = this.state.unlockRequests[i];
      if (req.closedAt) continue;
      // A request only speaks for the password it was made against.
      if ((req.generation ?? 0) !== generation) continue;
      if (req.status === 'pending' || req.status === 'ready' || req.status === 'revealed') {
        return req;
      }
    }
    return null;
  }

  requestUnlock({ note } = {}) {
    if (!this.sessionActive()) {
      throw fail('No active session — nothing is locked right now.', 409, 'not_locked');
    }
    const open = this.#latestOpenRequest();
    if (open && open.status !== 'revealed') return this.unlockStatus();
    const now = Date.now();
    const request = {
      id: randomUUID(),
      generation: this.#vaultGeneration(),
      requestedAt: new Date(now).toISOString(),
      availableAt: new Date(now + this.state.cooldownHours * 3600000).toISOString(),
      cooldownHours: this.state.cooldownHours,
      status: 'pending',
      revealedAt: null,
      closedAt: null,
      note: note ? String(note).slice(0, 500) : null,
    };
    this.state.unlockRequests.push(request);
    this.save();
    return this.unlockStatus();
  }

  cancelUnlock() {
    const open = this.#latestOpenRequest();
    if (!open || open.status === 'revealed') return this.unlockStatus();
    open.status = 'cancelled';
    open.closedAt = new Date().toISOString();
    this.save();
    return this.unlockStatus();
  }

  unlockStatus() {
    const open = this.#latestOpenRequest();
    const now = Date.now();
    if (!open) {
      return {
        pending: false,
        active: this.sessionActive(),
        cooldownHours: this.state.cooldownHours,
        request: null,
      };
    }
    const availableIn = Math.max(0, Date.parse(open.availableAt) - now);
    if (open.status === 'pending' && availableIn === 0) {
      open.status = 'ready';
      this.save();
    }
    let revealWindowRemainingMs = null;
    if (open.revealedAt) {
      revealWindowRemainingMs = Math.max(
        0,
        Date.parse(open.revealedAt) + REVEAL_WINDOW_MINUTES * 60000 - now,
      );
    }
    return {
      pending: open.status === 'pending' || open.status === 'ready',
      active: this.sessionActive(),
      cooldownHours: this.state.cooldownHours,
      request: {
        id: open.id,
        status: open.status,
        requestedAt: open.requestedAt,
        availableAt: open.availableAt,
        revealedAt: open.revealedAt,
        availableInMs: availableIn,
        revealable: Boolean(
          open.status === 'ready' || (open.revealedAt && revealWindowRemainingMs > 0),
        ),
        revealWindowRemainingMs,
      },
    };
  }

  /** The only method in the codebase that returns the password. */
  revealPassword() {
    const open = this.#latestOpenRequest();
    if (!open) {
      const last = this.state.unlockRequests.at(-1);
      if (last && last.closedReason) {
        throw fail(
          `That unlock no longer applies — ${last.closedReason} Request a new unlock and wait out the cooldown.`,
          409,
          'superseded',
        );
      }
      throw fail('No unlock has been requested.', 409, 'no_request');
    }
    const now = Date.now();
    const availableAt = Date.parse(open.availableAt);
    if (now < availableAt) {
      throw fail(
        `Cooldown still running — ${Math.ceil((availableAt - now) / 60000)} minute(s) left.`,
        423,
        'cooldown_active',
      );
    }
    if (open.revealedAt) {
      const windowEnds = Date.parse(open.revealedAt) + REVEAL_WINDOW_MINUTES * 60000;
      if (now > windowEnds) {
        throw fail(
          'That password was already revealed and the copy window has closed. Request a new unlock.',
          410,
          'sealed',
        );
      }
    } else {
      open.revealedAt = new Date(now).toISOString();
      open.status = 'revealed';
      this.save();
    }
    return {
      password: decrypt(this.state.vault.secret, this.store.key),
      revealedAt: open.revealedAt,
      copyWindowMinutes: REVEAL_WINDOW_MINUTES,
    };
  }

  unlockHistory(limit = 100) {
    return this.state.unlockRequests.slice(-limit).map((req) => ({
      id: req.id,
      status: req.status,
      requestedAt: req.requestedAt,
      availableAt: req.availableAt,
      revealedAt: req.revealedAt,
      closedAt: req.closedAt,
      closedReason: req.closedReason || null,
      cooldownHours: req.cooldownHours,
      note: req.note,
    }));
  }

  // --------------------------------------------------------------- check-in

  checkIn({ onTrack, date } = {}) {
    if (typeof onTrack !== 'boolean') throw fail('`onTrack` must be true or false.');
    const day = date || dateKey();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw fail('`date` must be YYYY-MM-DD.');
    const existing = this.state.checkins.find((c) => c.date === day);
    if (existing) {
      existing.onTrack = onTrack;
      existing.updatedAt = new Date().toISOString();
    } else {
      this.state.checkins.push({ date: day, onTrack, at: new Date().toISOString() });
      this.state.checkins.sort((a, b) => a.date.localeCompare(b.date));
    }
    this.save();
    return this.checkInSummary();
  }

  checkInSummary(limit = 30) {
    const today = dateKey();
    const todayEntry = this.state.checkins.find((c) => c.date === today) || null;
    return {
      today,
      checkedInToday: Boolean(todayEntry),
      todayOnTrack: todayEntry ? todayEntry.onTrack : null,
      currentStreak: currentStreak(this.state.checkins, today),
      longestStreak: longestStreak(this.state.checkins),
      totalCheckIns: this.state.checkins.length,
      history: this.state.checkins.slice(-limit),
    };
  }

  // ----------------------------------------------------------------- status

  status() {
    const active = this.sessionActive();
    return {
      ok: true,
      setupComplete: this.state.setupComplete,
      passwordExists: Boolean(this.state.vault && this.state.vault.secret),
      protection: {
        active,
        startedAt: this.state.session.startedAt,
        endsAt: this.state.session.endsAt,
        endedReason: active ? null : this.state.session.endedReason,
        remainingMs:
          active && this.state.session.endsAt
            ? Math.max(0, Date.parse(this.state.session.endsAt) - Date.now())
            : 0,
      },
      lists: {
        blocklistCount: this.state.blocklist.length,
        keywordCount: this.state.keywords.length,
        keywordScope: this.state.keywordScope,
      },
      unlock: this.unlockStatus(),
      checkin: this.checkInSummary(7),
    };
  }
}

module.exports = {
  App,
  fail,
  normaliseDomain,
  cleanList,
  cleanDomains,
  KEYWORD_SCOPES,
  REVEAL_WINDOW_MINUTES,
};
