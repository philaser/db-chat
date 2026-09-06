/** Public connection URLs contain location only. Full URLs belong in the secret vault. */
export function publicConnectionUri(value?: string): string | undefined {
  if (!value) return undefined;
  // MongoDB supports a comma-separated host list, which WHATWG URL does not parse.
  const match = /^(mongodb(?:\+srv)?|https?):\/\/([^/?#]+)([^?#]*)/i.exec(value);
  if (!match) return undefined;
  const authority = match[2].slice(match[2].lastIndexOf('@') + 1);
  return `${match[1]}://${authority}${match[3]}`;
}
