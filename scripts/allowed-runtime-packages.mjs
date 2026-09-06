/**
 * Packages permitted in the runtime dependency tree.
 *
 * Every entry here is code that runs in the same process as the adapter and
 * ships to anyone who installs it, so adding one is a deliberate, reviewable
 * edit rather than a side effect of an install.
 *
 * `zod` is not a direct dependency: the ACP SDK declares it as a peer
 * (`^3.25.0 || ^4.0.0`) and npm installs it into the consumer's tree, where
 * `npm-shrinkwrap.json` pins it to one exact version.
 */
export const ALLOWED_RUNTIME_PACKAGES = new Set(["@agentclientprotocol/sdk", "zod"]);
