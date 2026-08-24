import { networkInterfaces } from 'node:os';
import { buildApp } from './app.js';
import { config } from './config.js';
import { describeStore, getReadyStore } from './store/index.js';

// Fail loudly and immediately if the store is misconfigured, rather than on the
// first request. A long-lived server can afford to check once at boot.
await getReadyStore();

// Node binds every interface by default, which is what the phone needs: the
// Android app can no longer create plots locally, so it has to reach this
// server over the LAN. The addresses are printed to save hunting for them.
buildApp().listen(config.port, () => {
  console.log(`plot api listening on http://localhost:${config.port}  [store: ${describeStore()}]`);
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`  reachable from a phone on ${name}: http://${address.address}:${config.port}`);
      }
    }
  }
});
