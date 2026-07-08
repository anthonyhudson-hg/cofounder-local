import { KeyboardEvent, useState } from "react";

interface Props {
  onSubmit: (name: string) => void;
}

export function OnboardingModal({ onSubmit }: Props) {
  const [name, setName] = useState("");

  const submit = () => {
    if (name.trim()) onSubmit(name.trim());
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") submit();
  };

  return (
    <div className="modal-scrim">
      <div className="modal onboarding-modal">
        <div className="modal-header">
          <h3>Welcome to Cofounder</h3>
        </div>
        <div className="debug-body">
          <p className="settings-hint">
            Before we get started, what should your AI employees call you? This is used as the reporting
            manager for every employee, and injected into their prompts.
          </p>
          <input
            autoFocus
            className="onboarding-input"
            placeholder="Your full name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="settings-save-row">
            <button className="settings-save-btn" disabled={!name.trim()} onClick={submit}>
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
