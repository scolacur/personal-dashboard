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
