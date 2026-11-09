import { test as base, expect } from '@playwright/test';
import { DEFAULT_SETTINGS } from '../src/lib/settings';
import { lessonSources } from '../src/content/lessons';

export { expect };
export type { Page } from '@playwright/test';

/** Each case starts from a clean server state in the dedicated test server data directory. */
export const test = base.extend<{ serverState: void }>({
  serverState: [
    async ({ request }, use) => {
      const settings = await request.put('/api/settings', {
        data: { settings: DEFAULT_SETTINGS, clearApiKeys: true },
      });
      expect(settings.ok(), await settings.text()).toBe(true);
      const workspace = await request.put('/api/workspace', {
        data: {
          workspace: {
            currentId: lessonSources[0].id,
            sources: {},
            notes: [],
          },
        },
      });
      expect(workspace.ok(), await workspace.text()).toBe(true);
      await use();
    },
    { auto: true },
  ],
});
