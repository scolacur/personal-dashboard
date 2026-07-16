import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureRobotStateTable, isDispatchPaused, dispatchPauseState, pauseDispatch, resumeDispatch } from './state';

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
