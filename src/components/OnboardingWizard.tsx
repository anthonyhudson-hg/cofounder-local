import { useState } from "react";
import { Company } from "../types";
import { command } from "../lib/runtimeClient";

interface Props {
  company: Company;
  onDone: () => void;
}

interface SuggestedRole {
  jobTitle: string;
  department: string;
  mission: string;
  why: string;
}
interface Suggestion {
  profile: string;
  systemPrompt: string;
  roles: SuggestedRole[];
  channels: string[];
}

const STAGES = ["Idea", "Pre-seed", "Seed", "Series A", "Growth"];
const PRIORITIES = [
  "Build the product",
  "Get first customers",
  "Grow revenue",
  "Fundraise",
  "Hire the team",
  "Improve operations",
  "Talk to users",
];

export function OnboardingWizard({ company, onDone }: Props) {
  const [step, setStep] = useState<"about" | "focus" | "review">("about");
  const [name, setName] = useState(company.name === "My Company" ? "" : company.name);
  const [description, setDescription] = useState("");
  const [stage, setStage] = useState("Seed");
  const [industry, setIndustry] = useState("");
  const [customer, setCustomer] = useState("");
  const [priorities, setPriorities] = useState<string[]>([]);
  const [teamContext, setTeamContext] = useState("");

  const [generating, setGenerating] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<Set<number>>(new Set());
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);

  const togglePriority = (p: string) =>
    setPriorities((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const generate = async () => {
    setGenerating(true);
    setStep("review");
    try {
      const s = await command<Suggestion>(
        "onboarding.generate",
        { companyName: name, description, stage, industry, customer, priorities, teamContext },
        company.id,
      );
      setSuggestion(s);
      setSystemPrompt(s.systemPrompt);
      setSelectedRoles(new Set(s.roles.map((_, i) => i)));
      setSelectedChannels(new Set(s.channels.map((_, i) => i)));
    } finally {
      setGenerating(false);
    }
  };

  const finish = async () => {
    if (!suggestion) return;
    setApplying(true);
    try {
      await command(
        "onboarding.apply",
        {
          companyName: name || "My Company",
          profile: suggestion.profile,
          systemPrompt,
          roles: suggestion.roles.filter((_, i) => selectedRoles.has(i)),
          channels: suggestion.channels.filter((_, i) => selectedChannels.has(i)),
        },
        company.id,
      );
      onDone();
    } finally {
      setApplying(false);
    }
  };

  const skip = async () => {
    await command("company.update", { companyId: company.id, field: "name", value: name || company.name }, null);
    // mark onboarded without hires
    await command("onboarding.apply", { companyName: name || company.name, profile: company.profile, systemPrompt: company.system_prompt, roles: [], channels: [] }, company.id);
    onDone();
  };

  return (
    <div className="modal-scrim">
      <div className="modal onboarding-modal" onClick={(e) => e.stopPropagation()}>
        <div className="onboarding-head">
          <h2>Set up your company</h2>
          <div className="onboarding-steps">
            <span className={step === "about" ? "on" : ""}>1 · About</span>
            <span className={step === "focus" ? "on" : ""}>2 · Focus</span>
            <span className={step === "review" ? "on" : ""}>3 · Team</span>
          </div>
        </div>

        {step === "about" && (
          <div className="onboarding-body">
            <label className="settings-field">
              <span className="settings-label">Company name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc" autoFocus />
            </label>
            <label className="settings-field">
              <span className="settings-label">What does the company do? (one line)</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="AI tool that drafts sales emails for B2B teams" />
            </label>
            <div className="onboarding-row">
              <label className="settings-field">
                <span className="settings-label">Stage</span>
                <select value={stage} onChange={(e) => setStage(e.target.value)}>
                  {STAGES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </label>
              <label className="settings-field">
                <span className="settings-label">Industry</span>
                <input value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="SaaS, fintech, health…" />
              </label>
            </div>
            <label className="settings-field">
              <span className="settings-label">Who is your customer?</span>
              <input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Seed-stage B2B sales teams" />
            </label>
            <div className="onboarding-actions">
              <button className="settings-link-btn" onClick={skip}>Skip for now</button>
              <button className="settings-save-btn" disabled={!description.trim()} onClick={() => setStep("focus")}>Next</button>
            </div>
          </div>
        )}

        {step === "focus" && (
          <div className="onboarding-body">
            <div className="settings-field">
              <span className="settings-label">What are your priorities right now?</span>
              <div className="onboarding-chips">
                {PRIORITIES.map((pr) => (
                  <button key={pr} className={`onboarding-chip ${priorities.includes(pr) ? "on" : ""}`} onClick={() => togglePriority(pr)}>
                    {pr}
                  </button>
                ))}
              </div>
            </div>
            <label className="settings-field">
              <span className="settings-label">Anything else about your team / situation? (optional)</span>
              <textarea rows={3} value={teamContext} onChange={(e) => setTeamContext(e.target.value)} placeholder="Solo technical founder, no budget for hires yet, need help staying organized…" />
            </label>
            <div className="onboarding-actions">
              <button className="settings-link-btn" onClick={() => setStep("about")}>Back</button>
              <button className="settings-save-btn" onClick={generate}>Generate my company →</button>
            </div>
          </div>
        )}

        {step === "review" && (
          <div className="onboarding-body">
            {generating ? (
              <div className="onboarding-generating">Designing your company & team…</div>
            ) : suggestion ? (
              <>
                <div className="settings-field">
                  <span className="settings-label">Company operating principles (auto-generated — edit freely)</span>
                  <textarea className="app-settings-textarea" rows={5} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
                </div>

                <div className="settings-field">
                  <span className="settings-label">Suggested initial hires</span>
                  <p className="settings-hint">Only roles that add real value at your stage. Uncheck any you don't want. Your Chief of Staff is already hired.</p>
                  {suggestion.roles.length === 0 && <div className="onboarding-empty">No extra hires suggested yet — your Chief of Staff can cover a lot at this stage.</div>}
                  {suggestion.roles.map((r, i) => (
                    <label key={i} className="onboarding-role">
                      <input type="checkbox" checked={selectedRoles.has(i)} onChange={() => setSelectedRoles((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; })} />
                      <span className="onboarding-role-main">
                        <strong>{r.jobTitle}</strong> <span className="onboarding-role-dept">{r.department}</span>
                        <span className="onboarding-role-why">{r.why}</span>
                      </span>
                    </label>
                  ))}
                </div>

                {suggestion.channels.length > 0 && (
                  <div className="settings-field">
                    <span className="settings-label">Suggested channels</span>
                    <div className="onboarding-chips">
                      {suggestion.channels.map((c, i) => (
                        <button key={c} className={`onboarding-chip ${selectedChannels.has(i) ? "on" : ""}`} onClick={() => setSelectedChannels((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; })}>
                          #{c}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="onboarding-actions">
                  <button className="settings-link-btn" onClick={() => setStep("focus")}>Back</button>
                  <button className="settings-save-btn" disabled={applying} onClick={finish}>{applying ? "Setting up…" : "Finish setup"}</button>
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
