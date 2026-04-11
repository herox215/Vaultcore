import { describe, it } from 'vitest';

describe('EDIT-09: auto-save 2s idle debounce', () => {
  it.todo('EDIT-09: a single keystroke schedules onSave exactly once after 2000 ms');
  it.todo('EDIT-09: successive keystrokes within 2000 ms reset the debounce (only one save fires)');
  it.todo('EDIT-09: docChanged === false does not schedule a save');
});
