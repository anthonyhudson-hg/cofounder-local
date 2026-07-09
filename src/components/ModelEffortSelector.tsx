import { CaretDown } from "@phosphor-icons/react";
import { EFFORTS, Effort, MODELS, PROVIDERS, PROVIDER_LABELS } from "../types";
import { isProviderAvailable, useAvailableProviders } from "../lib/providerAvailability";

interface Props {
  model: string;
  effort: Effort;
  onModelChange: (m: string) => void;
  onEffortChange: (e: Effort) => void;
  disabled?: boolean;
}

export function ModelEffortSelector({ model, effort, onModelChange, onEffortChange, disabled }: Props) {
  const available = useAvailableProviders();
  return (
    <div className="model-effort-selector">
      <label className="pill-select">
        <select value={model} disabled={disabled} onChange={(e) => onModelChange(e.target.value)} title="Model">
          {PROVIDERS.map((p) => {
            const avail = isProviderAvailable(available, p);
            return (
              <optgroup key={p} label={avail ? PROVIDER_LABELS[p] : `${PROVIDER_LABELS[p]} — not connected`} disabled={!avail}>
                {MODELS.filter((m) => m.provider === p).map((m) => (
                  <option key={m.id} value={m.id} disabled={!avail}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        <CaretDown className="pill-select-caret" size={11} weight="bold" />
      </label>
      <label className="pill-select">
        <select
          value={effort}
          disabled={disabled}
          onChange={(e) => onEffortChange(e.target.value as Effort)}
          title="Reasoning effort"
        >
          {EFFORTS.map((e) => (
            <option key={e} value={e}>
              {e[0].toUpperCase() + e.slice(1)}
            </option>
          ))}
        </select>
        <CaretDown className="pill-select-caret" size={11} weight="bold" />
      </label>
    </div>
  );
}
