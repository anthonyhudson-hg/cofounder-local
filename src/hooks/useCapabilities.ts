import { useCallback, useEffect, useState } from "react";
import { command, query } from "../lib/runtimeClient";
import { CapabilityEffect, CapabilityGrant, CapabilityScope } from "../types";

/**
 * Standing capability grants for one employee, plus the set of scopes
 * currently grantable at all (reflects the server's tool registry — see
 * tools/registry.ts's listScopes(), which is why `scopes` isn't hardcoded
 * here). Unlike useAgentProfile, capability.list/grant/revoke are
 * company-scoped server-side (requireCompany), so this hook needs companyId.
 */
export function useCapabilities(companyId: string | null, employeeId: string) {
  const [scopes, setScopes] = useState<CapabilityScope[]>([]);
  const [grants, setGrants] = useState<CapabilityGrant[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!companyId) {
      setScopes([]);
      setGrants([]);
      setLoaded(true);
      return;
    }
    const [scopeRows, grantRows] = await Promise.all([
      query<CapabilityScope[]>("capability.scopes", {}, companyId),
      query<CapabilityGrant[]>("capability.list", { employeeId }, companyId),
    ]);
    setScopes(scopeRows);
    setGrants(grantRows);
    setLoaded(true);
  }, [companyId, employeeId]);

  useEffect(() => {
    setLoaded(false);
    reload();
  }, [reload]);

  const grant = useCallback(
    async (scope: string, maxEffect: CapabilityEffect) => {
      await command("capability.grant", { employeeId, scope, maxEffect }, companyId);
      setGrants((prev) => [...prev.filter((g) => g.scope !== scope), { scope, maxEffect }]);
    },
    [companyId, employeeId],
  );

  const revoke = useCallback(
    async (scope: string) => {
      await command("capability.revoke", { employeeId, scope }, companyId);
      setGrants((prev) => prev.filter((g) => g.scope !== scope));
    },
    [companyId, employeeId],
  );

  /** "none" (the default when there's no grant row) revokes; anything else grants. */
  const setEffect = useCallback(
    async (scope: string, effect: CapabilityEffect) => {
      if (effect === "none") await revoke(scope);
      else await grant(scope, effect);
    },
    [grant, revoke],
  );

  return { scopes, grants, loaded, setEffect, reload };
}
