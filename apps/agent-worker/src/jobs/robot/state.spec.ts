import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  activeMaintenanceHold,
  activeSessionLimitHold,
  clearSessionLimitHold,
  dispatchPauseState,
  ensureRobotStateTable,
  holdForSessionLimit,
  isDispatchPaused,
  maintenanceHold,
  pauseDispatch,
  releaseMaintenanceHold,
  resumeDispatch,
  sessionLimitHold,
  takeMaintenanceHold,
  writeState,
} from './state';

describe('robot dispatch-pause state', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureRobotStateTable(db);
  });

  it('defaults to not paused', () => {
    expect(isDispatchPaused(db)).toBe(false);
    expect(dispatchPauseState(db)).toEqual({ paused: false, reason: null, since: null });
  });

  it('pauses with a reason and timestamp', () => {
    pauseDispatch(db, 'auth 403', 1234);
    expect(isDispatchPaused(db)).toBe(true);
    expect(dispatchPauseState(db)).toEqual({ paused: true, reason: 'auth 403', since: 1234 });
  });

  it('keeps the first reason when paused again before a resume (does not clobber the trigger)', () => {
    pauseDispatch(db, 'first', 1000);
    pauseDispatch(db, 'second', 2000);
    expect(dispatchPauseState(db)).toEqual({ paused: true, reason: 'first', since: 1000 });
  });

  it('resume clears the flag and lets a fresh pause take hold', () => {
    pauseDispatch(db, 'first', 1000);
    resumeDispatch(db, 1500);
    expect(isDispatchPaused(db)).toBe(false);
    pauseDispatch(db, 'second', 2000);
    expect(dispatchPauseState(db)).toEqual({ paused: true, reason: 'second', since: 2000 });
  });
});

describe('session-limit hold (PD-470)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureRobotStateTable(db);
  });

  it('defaults to no hold', () => {
    expect(sessionLimitHold(db)).toBeNull();
    expect(activeSessionLimitHold(db, 1000)).toBeNull();
  });

  it('holds until the reset, then releases itself with no human action', () => {
    holdForSessionLimit(db, 5000, 'session limit', 1000);
    expect(activeSessionLimitHold(db, 4999)).toMatchObject({ until: 5000, reason: 'session limit', since: 1000 });
    // The whole point: at the reset the hold is gone, and it stays gone.
    expect(activeSessionLimitHold(db, 5000)).toBeNull();
    expect(sessionLimitHold(db)).toBeNull();
  });

  it('a later hold WINS — a second limit means a newer, more accurate reset time', () => {
    holdForSessionLimit(db, 5000, 'first', 1000);
    holdForSessionLimit(db, 9000, 'second', 2000);
    expect(activeSessionLimitHold(db, 3000)).toMatchObject({ until: 9000, reason: 'second' });
  });

  it('is independent of the human-cleared dispatch pause', () => {
    holdForSessionLimit(db, 5000, 'session limit', 1000);
    expect(isDispatchPaused(db)).toBe(false); // a quota wait must not read as an auth outage
    pauseDispatch(db, 'auth 403', 1000);
    expect(activeSessionLimitHold(db, 6000)).toBeNull(); // expiring the hold leaves the pause alone
    expect(isDispatchPaused(db)).toBe(true);
  });

  it('reads a corrupt or unparseable row as no hold rather than wedging the loop shut', () => {
    writeState(db, 'session_limit_until', 'not json', 1000);
    expect(sessionLimitHold(db)).toBeNull();
    writeState(db, 'session_limit_until', JSON.stringify({ reason: 'no until field' }), 1000);
    expect(sessionLimitHold(db)).toBeNull();
  });

  it('clearSessionLimitHold removes it outright', () => {
    holdForSessionLimit(db, 5000, 'x', 1000);
    clearSessionLimitHold(db, 1500);
    expect(sessionLimitHold(db)).toBeNull();
  });
});

describe('maintenance hold (PD-498, D-078)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureRobotStateTable(db);
  });

  it('defaults to none', () => {
    expect(maintenanceHold(db)).toBeNull();
    expect(activeMaintenanceHold(db, 1000)).toBeNull();
  });

  it('holds with a reason and a lapse deadline', () => {
    takeMaintenanceHold(db, 5000, 'numbering 2 decision(s)', 1000);
    expect(activeMaintenanceHold(db, 2000)).toMatchObject({ until: 5000, reason: 'numbering 2 decision(s)' });
  });

  it('lapses on its own, so a cycle that dies cannot wedge dispatch shut', () => {
    takeMaintenanceHold(db, 5000, 'numbering', 1000);
    expect(activeMaintenanceHold(db, 5001)).toBeNull();
    expect(maintenanceHold(db)).toBeNull(); // the read cleared it, like the session-limit hold
  });

  it('releases explicitly, which is the normal path', () => {
    takeMaintenanceHold(db, 5000, 'numbering', 1000);
    releaseMaintenanceHold(db, 2000);
    expect(activeMaintenanceHold(db, 2001)).toBeNull();
  });

  it('a second take extends the deadline', () => {
    takeMaintenanceHold(db, 5000, 'numbering', 1000);
    takeMaintenanceHold(db, 9000, 'numbering, still draining', 2000);
    expect(activeMaintenanceHold(db, 6000)?.until).toBe(9000);
  });

  // ── The reason this is a separate slot and not a third `kind` (see state.ts) ──────────────
  it('does not disturb a session-limit hold, and is not disturbed by one', () => {
    holdForSessionLimit(db, 8000, 'quota spent', 1000);
    takeMaintenanceHold(db, 5000, 'numbering', 1000);
    expect(activeSessionLimitHold(db, 2000)?.reason).toBe('quota spent');
    expect(activeMaintenanceHold(db, 2000)?.reason).toBe('numbering');
  });

  it('releasing the maintenance hold leaves a session-limit hold in force', () => {
    // The failure this prevents: the cycle finishes, clears "the hold", and dispatch resumes
    // straight into a spent quota — PD-470's bug, reintroduced by sharing one slot.
    holdForSessionLimit(db, 8000, 'quota spent', 1000);
    takeMaintenanceHold(db, 5000, 'numbering', 1000);
    releaseMaintenanceHold(db, 3000);
    expect(activeMaintenanceHold(db, 3001)).toBeNull();
    expect(activeSessionLimitHold(db, 3001)?.reason).toBe('quota spent');
  });

  it('a session limit arriving mid-cycle does not lift the maintenance hold', () => {
    takeMaintenanceHold(db, 9000, 'numbering', 1000);
    holdForSessionLimit(db, 2000, 'quota spent', 1000);
    // The session-limit hold expires first; the maintenance hold must still be holding.
    expect(activeSessionLimitHold(db, 2001)).toBeNull();
    expect(activeMaintenanceHold(db, 2001)?.reason).toBe('numbering');
  });

  it('survives a corrupt row without wedging the loop', () => {
    writeState(db, 'maintenance_hold', 'not json', 1000);
    expect(maintenanceHold(db)).toBeNull();
  });
});
