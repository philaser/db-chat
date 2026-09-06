import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('web-first build boundary', () => {
  it('builds the browser application and isolates the optional desktop package', () => {
    const vite = readFileSync('vite.config.ts', 'utf8');
    expect(vite).toContain("root: 'src/web'");
    expect(vite).toContain("base: '/'");
    const desktop = readFileSync('electron-builder.yml', 'utf8');
    expect(desktop).toContain('app: dist-desktop');
    expect(desktop).toContain('npmRebuild: false');
    expect(desktop).not.toContain('dist-web-server');
  });
});
