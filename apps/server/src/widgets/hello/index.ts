import type { BackendWidget } from '../../types';

export const widget: BackendWidget = {
  name: 'hello',
  registerRoutes(app) {
    app.get('/api/widgets/hello', async () => ({ message: 'Hello from the hello widget!' }));
  },
};
