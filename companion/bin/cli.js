#!/usr/bin/env node
'use strict';

const readline = require('node:readline');

const { App } = require('../lib/app');
const { Store } = require('../lib/store');
const { start } = require('../lib/server');
const { HOME, PORT } = require('../lib/paths');

const USAGE = `Accountability companion

  companion setup [--cooldown H] [--domains a.com,b.com] [--keywords "x,y"] [--no-examples]
      First run. Generates and encrypts a random vault password (never shown).

  companion serve [--port N]
      Start the local API + dashboard the extension talks to. Loopback only.

  companion status
      Session, lists, unlock cooldown and streak at a glance.

  companion domains [list|add <d>...|remove <d>...] [--password P]
  companion keywords [list|add <k>...|remove <k>...] [--password P]
      Edit the lists. While a session is active, --password is required.

  companion start --hours H [--password P]     Begin a locked session.
  companion stop --password P                  End it early (needs the password).

  companion unlock request [--note "..."]      Start the time-lock cooldown.
  companion unlock status                      How long is left.
  companion unlock reveal                      Show the password (after cooldown).
  companion unlock cancel                      Change your mind.
  companion unlock history                     Every request you have ever made.

  companion checkin [yes|no]                   Daily check-in + streak.

Data lives in ${HOME} (encrypted at rest). Nothing leaves this machine.`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[name] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        flags[name] = argv[i + 1];
        i += 1;
      } else flags[name] = true;
    } else positional.push(arg);
  }
  return { flags, positional };
}

const splitList = (value) =>
  String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

function fmtDuration(ms) {
  if (ms <= 0) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => (rl.close(), resolve(answer))));
}

function printStatus(app) {
  const s = app.status();
  const p = s.protection;
  console.log(`Setup complete : ${s.setupComplete ? 'yes' : 'no'}`);
  console.log(`Vault password : ${s.passwordExists ? 'exists (encrypted, not shown)' : 'none'}`);
  console.log(
    `Protection     : ${p.active ? `ACTIVE — ${fmtDuration(p.remainingMs)} left (until ${p.endsAt})` : 'inactive'}`,
  );
  console.log(`Blocklist      : ${s.lists.blocklistCount} domain(s)`);
  console.log(`Keywords       : ${s.lists.keywordCount} term(s)`);
  if (s.unlock.request) {
    const r = s.unlock.request;
    console.log(
      `Unlock         : ${r.status}${r.status === 'pending' ? ` — ${fmtDuration(r.availableInMs)} of cooldown left` : ''}`,
    );
  } else {
    console.log('Unlock         : no open request');
  }
  console.log(
    `Streak         : ${s.checkin.currentStreak} day(s) (longest ${s.checkin.longestStreak})`,
  );
}

async function handleList(app, kind, positional, flags) {
  const key = kind === 'domains' ? 'blocklist' : 'keywords';
  const [action, ...rest] = positional;
  const items = rest.flatMap(splitList);
  const current = app.state[key];

  if (!action || action === 'list') {
    if (current.length === 0) console.log(`(no ${kind} configured)`);
    else current.forEach((v) => console.log(`  ${v}`));
    return;
  }
  let next;
  if (action === 'add') next = [...current, ...items];
  else if (action === 'remove') {
    const drop = new Set(items.map((v) => v.toLowerCase()));
    next = current.filter((v) => !drop.has(v.toLowerCase()));
  } else throw new Error(`Unknown action "${action}". Use list, add or remove.`);

  const password = typeof flags.password === 'string' ? flags.password : undefined;
  const updated = app.updateConfig({ [key]: next, password });
  console.log(`${kind}: ${updated[key].length} entr(y/ies) now stored.`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);

  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return;
  }

  if (command === 'serve') {
    await start({ port: flags.port ? Number(flags.port) : PORT });
    return; // keep the process alive
  }

  const app = new App(new Store());

  switch (command) {
    case 'setup': {
      const result = app.setup({
        cooldownHours: flags.cooldown !== undefined ? Number(flags.cooldown) : undefined,
        blocklist: flags.domains ? splitList(flags.domains) : undefined,
        keywords: flags.keywords ? splitList(flags.keywords) : undefined,
        withExamples: !flags['no-examples'],
      });
      console.log('Setup complete.');
      console.log('');
      console.log('  A random password now exists for this vault.');
      console.log('  It has been encrypted at rest and is NOT displayed — not now, not on demand.');
      console.log(`  If you need it, request an unlock and wait out the ${result.cooldownHours}h cooldown.`);
      console.log('');
      console.log(`  Blocklist: ${result.blocklistCount} domain(s)   Keywords: ${result.keywordCount} term(s)`);
      console.log(`  Data directory: ${HOME}`);
      console.log('');
      console.log('Next: `companion start --hours 24`, then `companion serve`.');
      return;
    }
    case 'status':
      printStatus(app);
      return;
    case 'domains':
    case 'keywords':
      await handleList(app, command, positional, flags);
      return;
    case 'start': {
      const result = app.startSession({
        durationHours: Number(flags.hours),
        password: typeof flags.password === 'string' ? flags.password : undefined,
      });
      console.log(`Session active until ${result.session.endsAt}.`);
      console.log('A fresh password was generated and sealed. Blocking is now enforced.');
      return;
    }
    case 'stop': {
      app.stopSession({ password: typeof flags.password === 'string' ? flags.password : undefined });
      console.log('Session ended. Protection is off.');
      return;
    }
    case 'unlock': {
      const sub = positional[0] || 'status';
      if (sub === 'request') {
        const status = app.requestUnlock({ note: flags.note });
        console.log(`Unlock requested at ${status.request.requestedAt}.`);
        console.log(`The password becomes available at ${status.request.availableAt}`);
        console.log(`(${fmtDuration(status.request.availableInMs)} from now). This is logged.`);
        return;
      }
      if (sub === 'cancel') {
        app.cancelUnlock();
        console.log('Unlock request cancelled.');
        return;
      }
      if (sub === 'reveal') {
        const result = app.revealPassword();
        console.log('');
        console.log(`  ${result.password}`);
        console.log('');
        console.log(`Shown once. Copy it within ${result.copyWindowMinutes} minutes.`);
        return;
      }
      if (sub === 'history') {
        const rows = app.unlockHistory();
        if (rows.length === 0) console.log('(no unlock requests yet)');
        rows.forEach((r) =>
          console.log(
            `${r.requestedAt}  ${r.status.padEnd(10)}  available ${r.availableAt}${r.revealedAt ? `  revealed ${r.revealedAt}` : ''}`,
          ),
        );
        return;
      }
      const status = app.unlockStatus();
      if (!status.request) console.log('No open unlock request.');
      else if (status.request.status === 'pending')
        console.log(`Cooldown running — ${fmtDuration(status.request.availableInMs)} left.`);
      else console.log(`Request status: ${status.request.status}.`);
      return;
    }
    case 'checkin': {
      let answer = positional[0];
      if (!answer) {
        const summary = app.checkInSummary();
        if (summary.checkedInToday) {
          console.log(
            `Already checked in today (${summary.todayOnTrack ? 'on track' : 'not on track'}).`,
          );
        }
        answer = await ask('Stayed on track today? [y/n] ');
      }
      const normalised = String(answer).trim().toLowerCase();
      if (!['y', 'yes', 'n', 'no', 'true', 'false'].includes(normalised)) {
        throw new Error('Answer must be yes or no.');
      }
      const onTrack = ['y', 'yes', 'true'].includes(normalised);
      const summary = app.checkIn({ onTrack });
      console.log(onTrack ? 'Logged: on track.' : 'Logged: not on track. Tomorrow is a new day.');
      console.log(
        `Current streak: ${summary.currentStreak} day(s). Longest: ${summary.longestStreak} day(s).`,
      );
      return;
    }
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
