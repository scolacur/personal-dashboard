import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  activeSessionLimitHold,
  clearSessionLimitHold,
  dispatchPauseState,
  ensureRobotStateTable,
  holdForSessionLimit,
  isDispatchPaused,
  pauseDispatch,
  resumeDispatch,
  sessionLimitHold,
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
