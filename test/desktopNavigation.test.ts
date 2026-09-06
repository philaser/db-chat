// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applicationUrl, isApplicationNavigation, isExternalLink } from '../src/desktop/navigation';

describe('optional desktop origin boundary', () => {
  const app = applicationUrl('https://app.example.test/chat');
  it('allows HTTPS hosting and limits HTTP to explicit local development', () => {
    expect(applicationUrl('http://localhost:5173', true).hostname).toBe('localhost');
    for (const url of ['http://localhost:5173', 'http://app.example.test', 'file:///tmp/app.html', 'https://name:secret@app.example.test']) {
      expect(() => applicationUrl(url)).toThrow();
    }
    expect(() => applicationUrl('http://private.example.test', true)).toThrow();
  });
  it('keeps navigation on the configured origin without trusting prefixes', () => {
    expect(isApplicationNavigation('https://app.example.test/login', app)).toBe(true);
    for (const url of ['https://app.example.test.attacker.test', 'https://app.example.test:9443', 'https://app.example.test@attacker.test', 'javascript:alert(1)']) {
      expect(isApplicationNavigation(url, app)).toBe(false);
    }
  });
  it('never opens local files, custom commands or credential-bearing URLs externally', () => {
    expect(isExternalLink('https://docs.example.test')).toBe(true);
    expect(isExternalLink('mailto:support@example.test')).toBe(true);
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'custom-app:run', 'https://name:secret@example.test']) expect(isExternalLink(url)).toBe(false);
  });
});
