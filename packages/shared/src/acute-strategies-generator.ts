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
