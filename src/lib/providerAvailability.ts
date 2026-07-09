import { createContext, useContext } from "react";
import { Provider } from "../types";

/**
 * Which model providers are actually authenticated on this machine, shared via
 * context so any model picker (composer, thread panel, employee settings) can
 * gray out models whose provider isn't connected — without prop-drilling
 * availability through every intermediate component.
 *
 * `null` means "unknown" (health hasn't resolved, or the check errored): pickers
 * treat that as "don't gray anything out" so we never wrongly disable a working
 * provider on a transient hiccup.
 */
export const ProviderAvailabilityContext = createContext<Provider[] | null>(null);

export function useAvailableProviders(): Provider[] | null {
  return useContext(ProviderAvailabilityContext);
}

/** True when a provider should be selectable. Unknown availability ⇒ everything on. */
export function isProviderAvailable(available: Provider[] | null, provider: Provider): boolean {
  return !available || available.includes(provider);
}
