import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync('src/web/styles.css', 'utf8');

describe('web layout containment', () => {
  it('keeps settings chrome fixed while the active section scrolls', () => {
    const pageRule = styles.match(/\.settings-page\s*\{([^}]*)\}/)?.[1] ?? '';
    const layoutRule = styles.match(/\.settings-layout\s*\{([^}]*)\}/)?.[1] ?? '';
    const contentRule = styles.match(/\.settings-content\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(pageRule).toContain('height: 100%');
    expect(pageRule).toContain('overflow: hidden');
    expect(pageRule).toContain('grid-template-rows: auto minmax(0, 1fr)');
    expect(layoutRule).toContain('min-height: 0');
    expect(contentRule).toContain('min-height: 0');
    expect(contentRule).toContain('overflow-y: auto');
    expect(contentRule).toContain('overscroll-behavior: contain');
  });
});
