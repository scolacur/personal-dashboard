import { describe, it, expect } from 'vitest';
import { approveEdits, draftApproveError, draftFrom, type SuggestionDraft } from './ticket-suggestion-logic';

const proposal = { proposedTitle: 'Clean up', proposedBody: 'do the things', proposedEpicId: 4 };

describe('ticket-suggestion-logic', () => {
  it('draftFrom seeds the draft from the proposal', () => {
    expect(draftFrom(proposal)).toEqual({ title: 'Clean up', body: 'do the things', epicId: 4 });
  });

  it('approveEdits sends nothing for an unchanged draft', () => {
    expect(approveEdits(proposal, draftFrom(proposal))).toEqual({});
  });

  it('approveEdits sends only the changed fields', () => {
    const draft: SuggestionDraft = { title: 'New', body: 'do the things', epicId: 9 };
    expect(approveEdits(proposal, draft)).toEqual({ title: 'New', epicId: 9 });
  });

  it('approveEdits ignores a whitespace-only title change', () => {
    const draft: SuggestionDraft = { title: '  Clean up  ', body: 'do the things', epicId: 4 };
    expect(approveEdits(proposal, draft)).toEqual({});
  });

  it('draftApproveError requires a title and an epic', () => {
    expect(draftApproveError({ title: 'x', body: '', epicId: 1 })).toBeNull();
    expect(draftApproveError({ title: '   ', body: '', epicId: 1 })).toMatch(/title/i);
    expect(draftApproveError({ title: 'x', body: '', epicId: null })).toMatch(/epic/i);
  });
});
