import { InMemoryMemoryStore } from '../src/index';
import { runMemoryStoreContract } from './contract';

runMemoryStoreContract(
  'InMemoryMemoryStore',
  (opts) => new InMemoryMemoryStore({ ...(opts?.now ? { now: opts.now } : {}) }),
);
