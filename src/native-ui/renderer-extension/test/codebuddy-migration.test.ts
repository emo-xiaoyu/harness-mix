import { describe, it, expect } from 'vitest';
import { readNewThreadAgentPreference, RENDERER_NEW_THREAD_PREFERENCE_KEY, readNewThreadExternalConfigurationPreference } from '../src/renderer-new-thread-preference.js';
import { createAgentGroupPreferenceStore, AGENT_GROUP_PREFERENCE_STORAGE_KEY } from '../src/agent-group-preference.js';
import { DEFAULT_RENDERER_AGENTS } from '../src/agent-selection-state.js';
import { harnessModelCatalogSchema } from '@codexhost/shared-contracts';

describe('CodeBuddy rename compatibility', () => {
  it('keeps old last-agent, model and group preferences under the canonical name', () => {
    const values = new Map([
      [RENDERER_NEW_THREAD_PREFERENCE_KEY, JSON.stringify({ version: 1, lastAgent: 'workbuddy', externalByAgent: { workbuddy: { model: { id: 'original-model' } } } })],
      [AGENT_GROUP_PREFERENCE_STORAGE_KEY, JSON.stringify([{ agent: 'workbuddy', section: 'more' }])],
    ]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    expect(readNewThreadAgentPreference(new Set(DEFAULT_RENDERER_AGENTS), storage)).toBe('codebuddy');
    const catalog = harnessModelCatalogSchema.parse({ models: [{ ref: { id: 'original-model' }, label: 'Native' }], thinkingOptions: [] });
    expect(readNewThreadExternalConfigurationPreference('codebuddy', catalog, undefined, storage)?.model.id).toBe('original-model');
    expect(createAgentGroupPreferenceStore(storage as Storage).sectionOf('codebuddy')).toBe('more');
    expect(DEFAULT_RENDERER_AGENTS).toContain('kiro-cli');
    expect(DEFAULT_RENDERER_AGENTS).toContain('cursor-cli');
    expect(DEFAULT_RENDERER_AGENTS).not.toContain('workbuddy');
  });
});
