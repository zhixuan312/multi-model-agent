import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CLIENT_CAPABILITIES } from '../../../packages/server/src/provisioning/capability-registry.js';
import { createRealProvisioningPort } from '../../../packages/server/src/provisioning/real-port.js';
import { writerForClient } from '../../../packages/server/src/provisioning/writers/registry.js';

/**
 * Which clients are supported is stated in THREE places, and they must agree.
 *
 *   1. `capability-registry.ts` — an empty `mcpConfigPaths` is the "no verified path" signal.
 *   2. `writers/registry.ts` — two lookup TABLES, whose own doc says adding a client is adding a
 *      row "and still never a `switch`".
 *   3. `real-port.ts`'s `registrationPathFor` — which is exactly that switch, resolving a client
 *      to the path its writer targets.
 *
 * `gated-registration-writers.test.ts` already binds (1) to (2) against the evidence artifact.
 * Nothing bound (3) to either, and drift there fails SILENTLY: `registrationPathFor` returning
 * undefined makes `readRegistration` report "nothing there", `isRegistrationReachable` report
 * false, and every mutation degrade — so a client with a working, evidence-backed writer whose
 * switch case was forgotten looks permanently unprovisionable, with nothing naming the cause.
 *
 * Asserted through the public port rather than by exporting the switch, so this tests the surface
 * the service actually consumes.
 */
describe('contract: the registration path switch agrees with the writer registry', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'mma-path-agreement-'));
  afterAll(() => rmSync(homeDir, { recursive: true, force: true }));

  const port = createRealProvisioningPort({
    homeDir,
    daemonPort: 7337,
    cliEntrypoint: '/opt/mma/cli.js',
    release: '0.0.0-test',
    stateDir: join(homeDir, 'state'),
    // Claude Desktop's path is platform-dependent; pin it so this asserts the mapping rather
    // than whatever host the suite happens to run on.
    platform: 'darwin',
  });

  it('resolves a path for exactly the clients that have a writer', () => {
    const disagreements = CLIENT_CAPABILITIES.flatMap((capability) => {
      const hasWriter = writerForClient(capability.id) !== undefined;
      const path = port.readRegistration(capability.id, capability).path;
      const hasPath = path.length > 0;
      return hasWriter === hasPath
        ? []
        : [`${capability.id}: writer=${hasWriter} path=${JSON.stringify(path)}`];
    });
    expect(disagreements).toEqual([]);
  });

  it('agrees with the capability registry about which clients are blocked', () => {
    // The third statement of the same fact. An empty `mcpConfigPaths` and an absent writer and an
    // unresolvable path must all describe the same set of clients.
    const blockedByRegistry = CLIENT_CAPABILITIES
      .filter((capability) => capability.mcpConfigPaths.length === 0)
      .map((capability) => capability.id);
    const blockedByPath = CLIENT_CAPABILITIES
      .filter((capability) => port.readRegistration(capability.id, capability).path.length === 0)
      .map((capability) => capability.id);
    expect(blockedByPath).toEqual(blockedByRegistry);
  });
});
