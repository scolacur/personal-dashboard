// Shared types between server and web.
// Import from '@dashboard/shared' in both apps.
export type {
  TodoStatus,
  TodoPriority,
  AgentTodo,
  CreateTodoInput,
  UpdateTodoInput,
  AgentProject,
  CreateProjectInput,
} from './agent-dashboard';
export { TODO_STATUSES, TODO_PRIORITIES } from './agent-dashboard';
