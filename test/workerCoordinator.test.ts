// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../src/server/accountStore';
import { WorkerCoordinator } from '../src/server/workerCoordinator';
const instances:WorkerCoordinator[]=[];
const fixture=()=>{
 const accounts=new AccountStore({defaultModel:'fixture',sessionTtlMs:60000,secretKey:'fixture'});
 const lost=vi.fn(),cancel=vi.fn();
 const worker=new WorkerCoordinator(accounts,cancel,lost,{leaseMs:1000,heartbeatMs:100});instances.push(worker);
 return {accounts,lost,cancel,worker};
};
afterEach(async()=>{await Promise.all(instances.splice(0).map(w=>w.stop()));vi.useRealTimers();});
describe('worker lease readiness',()=>{
 it('renews while healthy and fails closed immediately on failed coordination',async()=>{
  vi.useFakeTimers();const f=fixture();await f.worker.start();expect(f.worker.ready).toBe(true);
  const heartbeat=vi.spyOn(f.accounts,'heartbeatWorker');await vi.advanceTimersByTimeAsync(200);expect(heartbeat).toHaveBeenCalledTimes(2);
  heartbeat.mockImplementation(()=>{throw new Error('Database unavailable');});await vi.advanceTimersByTimeAsync(100);
  expect(f.worker.ready).toBe(false);expect(f.lost).toHaveBeenCalledOnce();expect(()=>f.worker.assertReady()).toThrow('temporarily unavailable');
  await vi.advanceTimersByTimeAsync(2000);expect(f.lost).toHaveBeenCalledOnce();
 });
 it('does not let delayed heartbeat success revive a locally expired worker',async()=>{
  vi.useFakeTimers();const f=fixture();await f.worker.start();
  let resolve!:(value:{alive:boolean;cancelledTurns:string[]})=>void;
  vi.spyOn(f.accounts,'heartbeatWorker').mockImplementation(()=>new Promise(r=>{resolve=r;}) as never);
  await vi.advanceTimersByTimeAsync(950);expect(f.worker.ready).toBe(false);expect(f.lost).toHaveBeenCalledOnce();
  resolve({alive:true,cancelledTurns:[]});await vi.advanceTimersByTimeAsync(1);expect(f.worker.ready).toBe(false);
 });
 it('delivers durable cancellation and never resumes after release',async()=>{
  vi.useFakeTimers();const f=fixture();await f.worker.start();
  vi.spyOn(f.accounts,'heartbeatWorker').mockReturnValue({alive:true,cancelledTurns:['remote-turn']});
  await vi.advanceTimersByTimeAsync(100);expect(f.cancel).toHaveBeenCalledWith(['remote-turn']);
  await f.worker.stop();expect(f.worker.ready).toBe(false);expect(()=>f.worker.assertReady()).toThrow('temporarily unavailable');
 });
});
