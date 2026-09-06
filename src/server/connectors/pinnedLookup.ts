import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
/** The address was resolved and validated immediately before the connection. */
export function pinnedLookup(address: string): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    const family = isIP(address);
    if (!family) { callback(new Error('Invalid pinned database address.')); return; }
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as LookupFunction;
}
