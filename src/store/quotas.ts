import { RegistryError } from "../errors.js";
import type { InstanceQuotas, StoredAgent } from "../types.js";

/** Check capacity against the snapshot protected by the store's atomic write. */
export function assertInstanceCapacity(active: StoredAgent[], agent: StoredAgent, quotas?: InstanceQuotas): void {
  if (!quotas || active.some((entry) => entry.id === agent.id && entry.instanceId === agent.instanceId)) return;
  if (quotas.maxInstancesPerAgent > 0 && active.filter((entry) => entry.id === agent.id).length >= quotas.maxInstancesPerAgent) {
    throw new RegistryError(429, "agent_instance_quota_exceeded", `Agent '${agent.id}' may have at most ${quotas.maxInstancesPerAgent} active instances`);
  }
  if (quotas.maxActiveInstances > 0 && active.length >= quotas.maxActiveInstances) {
    throw new RegistryError(429, "registry_instance_quota_exceeded", `The registry may have at most ${quotas.maxActiveInstances} active instances`);
  }
}
