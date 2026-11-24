// Pure helpers for the Ticket Suggestions section of the Decisions inbox (PD-979, D-116). Kept out
// of the card component so they are unit-testable (apps/web's vitest cannot import .svelte).

import type { ApproveSuggestionEdits, TicketSuggestion } from '@dashboard/shared';

/** The editable draft a Modify form holds, initialised from the suggestion's proposal. */
export interface SuggestionDraft {
  title: string;
  body: string;
  epicId: number | null;
}

export function draftFrom(
  s: Pick<TicketSuggestion, 'proposedTitle' | 'proposedBody' | 'proposedEpicId'>,
): SuggestionDraft {
  return { title: s.proposedTitle, body: s.proposedBody, epicId: s.proposedEpicId };
}

/**
 * The approve payload: only the fields the draft actually changed from the proposal (Modify). A
 * clean approve therefore sends `{}`, and the server keeps every proposed value. Title is compared
 * trimmed, since the server trims it anyway.
 */
export function approveEdits(
  s: Pick<TicketSuggestion, 'proposedTitle' | 'proposedBody' | 'proposedEpicId'>,
  draft: SuggestionDraft,
): ApproveSuggestionEdits {
  const edits: ApproveSuggestionEdits = {};
  if (draft.title.trim() !== s.proposedTitle.trim()) edits.title = draft.title;
  if (draft.body !== s.proposedBody) edits.body = draft.body;
  if (draft.epicId !== s.proposedEpicId) edits.epicId = draft.epicId;
  return edits;
}

/** Why the draft cannot be approved yet (a non-blank title and a chosen Epic are required), or null. */
export function draftApproveError(draft: SuggestionDraft): string | null {
  if (draft.title.trim() === '') return 'A title is required.';
  if (draft.epicId === null) return 'Choose an Epic for the new ticket.';
  return null;
}
