import { describe, expect, it } from 'vitest';
import { HUMAN_REPLY_MARKER } from '@dashboard/shared';
import { steveApproved } from './open-prs';

const BOT = 'sortie-bot-55';
const review = (login: string, state: string, at: string, assoc = 'OWNER', body = '') => ({
  author: { login },
  authorAssociation: assoc,
  state,
  body,
  submittedAt: at,
});

describe('steveApproved (PD-1007), mirroring authorized-approval.sh', () => {
  it('counts an APPROVED from the repo owner', () => {
    expect(steveApproved([review('scolacur', 'APPROVED', '2026-11-24T01:00:00Z')], BOT)).toBe(true);
  });

  it('counts a collaborator only with the human-reply marker, and never the bot', () => {
    expect(steveApproved([review('helper', 'APPROVED', '2026-11-24T01:00:00Z', 'COLLABORATOR')], BOT)).toBe(false);
    expect(steveApproved([review('helper', 'APPROVED', '2026-11-24T01:00:00Z', 'COLLABORATOR', `ok ${HUMAN_REPLY_MARKER}`)], BOT)).toBe(true);
    expect(steveApproved([review(BOT, 'APPROVED', '2026-11-24T01:00:00Z', 'OWNER')], BOT)).toBe(false);
  });

  it("uses each reviewer's latest review, so a later change request supersedes an approval", () => {
    const approvedThenChanged = [
      review('scolacur', 'APPROVED', '2026-11-24T01:00:00Z'),
      review('scolacur', 'CHANGES_REQUESTED', '2026-11-24T02:00:00Z'),
    ];
    expect(steveApproved(approvedThenChanged, BOT)).toBe(false);
    expect(steveApproved([...approvedThenChanged].reverse(), BOT)).toBe(false);
  });

  it('reads no reviews as not approved', () => {
    expect(steveApproved(undefined, BOT)).toBe(false);
    expect(steveApproved([{ author: null, state: 'APPROVED' }], BOT)).toBe(false);
  });
});
