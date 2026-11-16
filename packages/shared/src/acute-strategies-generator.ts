export const IDEA_TYPES = ['Acute', 'Oblique', 'Inspiration'] as const;
export type IdeaType = (typeof IDEA_TYPES)[number];

export interface AcuteStrategyIdea {
  id: number;
  text: string;
  type: IdeaType;
  tags: string[];
  created_at: number;
  updated_at: number;
}

export interface CreateIdeaInput {
  text: string;
  type: IdeaType;
  tags: string[];
}

export interface UpdateIdeaInput {
  text?: string;
  type?: IdeaType;
  tags?: string[];
}

/** Batch import: one idea per line, with a single type + tag set for the whole batch (T69). */
export interface ImportIdeasInput {
  lines: string[];
  type: IdeaType;
  tags: string[];
}

export interface ImportIdeasResult {
  created: AcuteStrategyIdea[];
  skipped: number;
}

/**
 * One row in the Draw History (T70): a snapshot of what came up on a press of Shuffle.
 * `idea_text` / `idea_type` are captured at draw time so history reads true after the idea is
 * edited and survives its deletion — at which point `idea_id` becomes null (ON DELETE SET NULL).
 */
export interface AcuteStrategyDraw {
  id: number;
  idea_id: number | null;
  idea_text: string;
  idea_type: IdeaType;
  drawn_at: number;
}

/** Default and maximum `limit` for GET /draws (T70). */
export const DRAWS_DEFAULT_LIMIT = 20;
export const DRAWS_MAX_LIMIT = 200;
