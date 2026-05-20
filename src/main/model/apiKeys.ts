export function normalizeApiKey(apiKey: string): string {
  const normalized = apiKey.trim().replace(/\s+/g, '');

  if (!normalized) {
    throw new Error('API key is empty.');
  }

  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 33 || code > 126) {
      throw new Error('API key contains unsupported characters. Paste the raw key text without emoji or rich text formatting.');
    }
  }

  return normalized;
}
