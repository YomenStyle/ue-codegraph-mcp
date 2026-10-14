import { parentPort } from 'worker_threads';
import { parseTask } from './parse-task.js';

// Protocol: { id, paths[] } -> { id, results[] }
parentPort!.on('message', (msg: { id: number; paths: string[] }) => {
  const results = msg.paths.map(p => {
    try {
      return parseTask(p);
    } catch (err) {
      return { absolutePath: p, error: String(err) };
    }
  });
  parentPort!.postMessage({ id: msg.id, results });
});
