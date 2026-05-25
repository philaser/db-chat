import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');

describe('release workflow', () => {
  it('uploads only installable release packages', () => {
    expect(releaseWorkflow).not.toContain('--publish always');
    expect(releaseWorkflow).toMatch(/--publish never/g);
    expect(releaseWorkflow).toContain('gh release upload "${RELEASE_TAG}"');

    expect(releaseWorkflow).toContain('release/*.dmg');
    expect(releaseWorkflow).toContain('release/*.exe');
    expect(releaseWorkflow).toContain('release/*.AppImage');
    expect(releaseWorkflow).toContain('release/*.deb');

    expect(releaseWorkflow).not.toContain('release/*.blockmap');
    expect(releaseWorkflow).not.toContain('release/latest*.yml');
  });
});
