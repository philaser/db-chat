import { createRequire } from 'node:module';
import { Transform, type Duplex } from 'node:stream';
import { WireFrameGuard, WireResponseBudget } from './wireLimits.js';

/** MongoDB BSON batches may approach 16 MiB, including their command envelope. */
export const MAX_MONGO_MESSAGE_BYTES = 20 * 1024 * 1024;

// The driver exposes connectionType for custom connections but omits its type
// from the public declarations. Pin this integration with real-driver tests and
// fail closed if an upgrade changes the stream seam. Both TLS and TCP reach it.
export function boundedMongoConnectionType(): unknown {
  const { Connection } = createRequire(import.meta.url)('mongodb/lib/cmap/connection.js') as {
    Connection: new (socket: Duplex, options: unknown) => { messageStream: Transform };
  };
  if (typeof Connection !== 'function') throw new Error('This MongoDB driver cannot enforce database transport limits.');
  return class extends Connection {
    constructor(socket: Duplex, options: unknown) {
      super(socket, options);
      if (!(this.messageStream instanceof Transform)) {
        socket.destroy();
        throw new Error('This MongoDB driver cannot enforce database transport limits.');
      }
      const budget = new WireResponseBudget();
      budget.reset(true);
      const guard = new WireFrameGuard('mongodb', budget, MAX_MONGO_MESSAGE_BYTES);
      const checked = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          try { guard.accept(chunk); callback(null, chunk); }
          catch (error) { callback(error as Error); }
        }
      });
      checked.on('error', error => socket.destroy(error));
      socket.on('close', () => checked.destroy());
      socket.unpipe(this.messageStream);
      checked.pipe(this.messageStream);
      socket.pipe(checked);
    }
  };
}
