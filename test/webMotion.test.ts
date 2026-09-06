import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync('src/web/styles.css', 'utf8');

describe('web motion system', () => {
  it('uses the canonical timing tokens for state and panel motion', () => {
    expect(styles).toContain('--motion-instant: 80ms');
    expect(styles).toContain('--motion-fast: 120ms');
    expect(styles).toContain('--motion-standard: 180ms');
    expect(styles).toContain('--motion-panel: 220ms');
    expect(styles).toContain('transition: grid-template-columns var(--motion-panel) var(--ease-panel)');
  });

  it('defines restrained entrances and a global reduced-motion fallback', () => {
    expect(styles).toContain('@keyframes motion-popover-in');
    expect(styles).toContain('@keyframes motion-content-in');
    expect(styles).toContain('@keyframes motion-panel-in');
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.01ms/);
  });

  it('disables pane transitions while the inspector is directly resized', () => {
    expect(styles).toContain('.workspace-shell:has(.inspector-resize-handle.is-resizing) { transition: none; }');
  });
});
