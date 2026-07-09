import { ProviderStatus } from "../hooks/useProviderHealth";

interface Props {
  providers: ProviderStatus[];
  loading: boolean;
  onRecheck: () => void;
}

interface Setup {
  provider: "claude" | "codex";
  loginCli: string;
  envVar: string;
  keyUrl: string;
}

const SETUP: Setup[] = [
  { provider: "claude", loginCli: "claude login", envVar: "ANTHROPIC_API_KEY", keyUrl: "console.anthropic.com" },
  { provider: "codex", loginCli: "codex login", envVar: "OPENAI_API_KEY", keyUrl: "platform.openai.com" },
];

/**
 * Hard gate shown when NO agent provider is authenticated. Cofounder can't run
 * a single employee turn without one, so rather than let the user onboard a
 * company and hit an opaque "process exited with code 1" on their first
 * message, we stop here with copy-pasteable setup instructions and a re-check.
 */
export function ProviderSetupGate({ providers, loading, onRecheck }: Props) {
  const byProvider = new Map(providers.map((p) => [p.provider, p]));

  return (
    <div className="modal-scrim">
      <div className="modal provider-gate">
        <div className="modal-header">
          <h3>Connect an AI model to get started</h3>
        </div>
        <div className="debug-body">
          <p className="settings-hint">
            Cofounder runs your AI employees on Claude or OpenAI Codex, and neither is set up on this
            machine yet. Connect <strong>one</strong> of the options below, then re-check.
          </p>

          {SETUP.map((s) => {
            const status = byProvider.get(s.provider);
            const label = status?.label ?? s.provider;
            return (
              <div key={s.provider} className="provider-gate-card">
                <div className="provider-gate-card-title">{label}</div>
                <ol className="provider-gate-steps">
                  <li>
                    Log in with its CLI — run <code>{s.loginCli}</code> in a terminal — then click
                    “Re-check” below.
                  </li>
                  <li>
                    <em>Or</em> set an <code>{s.envVar}</code> environment variable (get a key from{" "}
                    {s.keyUrl}) and <strong>restart the app</strong> so it picks the key up.
                  </li>
                </ol>
                {status && !status.available && status.detail && (
                  <div className="provider-gate-detail" title={status.detail}>
                    {status.detail}
                  </div>
                )}
              </div>
            );
          })}

          <div className="settings-save-row">
            <button className="settings-save-btn" disabled={loading} onClick={onRecheck}>
              {loading ? "Checking…" : "Re-check"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
