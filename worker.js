import { analyze } from './core.js';
self.onmessage = ({ data }) => {
  try {
    self.postMessage({ result: analyze(data) });
  } catch {
    self.postMessage({
      error: 'Inference could not finish within browser limits. Simplify the expression and retry.',
    });
  }
};
