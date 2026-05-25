import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Vite production config', () => {
  it('uses relative asset URLs for packaged Electron file loading', () => {
    const viteConfig = readFileSync(path.join(process.cwd(), 'vite.config.ts'), 'utf8');

    expect(viteConfig).toMatch(/base:\s*['"]\.\/['"]/);
  });
});
