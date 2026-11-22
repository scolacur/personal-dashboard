import type Database from 'better-sqlite3';
import { choiceValue, habitDay } from '@dashboard/shared';
import {
  createChoiceOption,
  createItem,
  getSettings,
  moveItem,
  setCompletion,
  setMetricValue,
  setSchedule,
} from '../lib/habits';

/**
 * Habit Tracker fixture (PD-798): enough data that every Today and Habits surface has something to
 * draw. Written through the store's own functions, so a schema change that breaks it fails its spec
 * instead of silently producing an empty screenshot.
 *
 *  - four habits: two due today (daily) with a few weeks of history for streaks, one per-week, and
 *    one ("Floss") left unchecked yesterday so the Today yesterday banner renders (T889);
 *  - a "Morning Routine" set with two daily child habits, so the nested-habit (set) rendering is
 *    exercised on both Today and the Log › By Day grid (Steve's review on PD-725);
 *  - one metric of each type, with today's value set on two and the third left empty, so both the
 *    filled and the empty input render — Mood carries a multi-value day so the auto-height cell shows.
 */

const DAY_MS = 24 * 60 * 60_000;

export function seedHabitTracker(db: Database.Database, now: number): void {
  const settings = getSettings(db);
  const day = (ago: number) => habitDay(now - ago * DAY_MS, settings);

  const gym = createItem(db, { name: 'Gym' }, now);
  const read = createItem(db, { name: 'Read 20 minutes' }, now);
  const stretch = createItem(db, { name: 'Stretch' }, now);
  setSchedule(db, gym.id, { kind: 'days_of_week', daysMask: 0b1111111 }, now);
  setSchedule(db, read.id, { kind: 'days_of_week', daysMask: 0b1111111 }, now);
  setSchedule(db, stretch.id, { kind: 'per_week', perWeekN: 3 }, now);

  // A daily habit left unchecked yesterday, so the Today "Yesterday: N habits unchecked" banner
  // renders (T889). Due daily, with no completion on yesterday (or today).
  const floss = createItem(db, { name: 'Floss' }, now);
  setSchedule(db, floss.id, { kind: 'days_of_week', daysMask: 0b1111111 }, now);

  // A streak with one gap for Gym, a long unbroken one for Read, two this week for Stretch.
  for (let ago = 1; ago <= 21; ago++) {
    if (ago !== 9) setCompletion(db, { itemId: gym.id, day: day(ago), done: true }, now);
    setCompletion(db, { itemId: read.id, day: day(ago), done: true }, now);
  }
  setCompletion(db, { itemId: read.id, day: day(0), done: true }, now);
  setCompletion(db, { itemId: stretch.id, day: day(1), done: true }, now);
  setCompletion(db, { itemId: stretch.id, day: day(3), done: true }, now);

  // A "Morning Routine" set with two daily children, so nested habits render on Today and By Day.
  const routine = createItem(db, { name: 'Morning Routine' }, now);
  const vitamins = createItem(db, { name: 'Vitamins' }, now);
  const meditate = createItem(db, { name: 'Meditate' }, now);
  setSchedule(db, vitamins.id, { kind: 'days_of_week', daysMask: 0b1111111 }, now);
  setSchedule(db, meditate.id, { kind: 'days_of_week', daysMask: 0b1111111 }, now);
  moveItem(db, vitamins.id, routine.id, [vitamins.id]);
  moveItem(db, meditate.id, routine.id, [vitamins.id, meditate.id]);
  for (let ago = 1; ago <= 14; ago++) {
    setCompletion(db, { itemId: vitamins.id, day: day(ago), done: true }, now);
    if (ago % 3 !== 0) setCompletion(db, { itemId: meditate.id, day: day(ago), done: true }, now);
  }
  setCompletion(db, { itemId: vitamins.id, day: day(0), done: true }, now);

  const sleep = createItem(db, { name: 'Bedtime', kind: 'metric', metricType: 'time' }, now);
  const coffee = createItem(db, { name: 'Coffees', kind: 'metric', metricType: 'number' }, now);
  const mood = createItem(db, { name: 'Mood', kind: 'metric', metricType: 'choice' }, now);
  const options = ['Great', 'Fine', 'Tired', 'Stressed'].map((label) => createChoiceOption(db, mood.id, label));
  const [great, fine, tired, stressed] = options.map((o) => o!.id);

  for (let ago = 1; ago <= 7; ago++) {
    setMetricValue(db, { itemId: sleep.id, day: day(ago), value: ago % 2 ? '23:15' : '00:40' }, now);
    setMetricValue(db, { itemId: coffee.id, day: day(ago), value: String(1 + (ago % 3)) }, now);
    setMetricValue(db, { itemId: mood.id, day: day(ago), value: choiceValue(ago % 2 ? [great] : [tired]) }, now);
  }
  // A few-value Mood day, so the By Day grid's auto-height cell visibly wraps (Steve's review).
  setMetricValue(db, { itemId: mood.id, day: day(2), value: choiceValue([fine, tired, stressed]) }, now);
  setMetricValue(db, { itemId: coffee.id, day: day(0), value: '2' }, now);
  setMetricValue(db, { itemId: mood.id, day: day(0), value: choiceValue([great, tired]) }, now);
}

export function habitTrackerIsEmpty(db: Database.Database): boolean {
  return (db.prepare('SELECT COUNT(*) AS n FROM habit_items').get() as { n: number }).n === 0;
}
