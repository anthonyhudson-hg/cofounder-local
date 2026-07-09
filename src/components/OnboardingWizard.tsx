import { useState } from "react";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { Company } from "../types";
import { command } from "../lib/runtimeClient";
import { urlToResizedDataUrl } from "../lib/avatar";
import { FullCandidate } from "../lib/candidates";
import { CandidatePicker } from "./CandidatePicker";

interface Props {
  company: Company;
  onDone: (newDmConversationIds: string[]) => void;
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

/** A suggested role with the candidate the founder picked for it — the wire shape of onboarding.apply's `roles`. */
interface ChosenRole {
  jobTitle: string;
  department: string;
  name: string;
  avatar: string | null;
  mission: string;
  preamble: string;
  additionalDetails: string;
  responsibilities: string[];
  personality: string;
  communicationStyle: string;
  expertise: string[];
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
  const [step, setStep] = useState<"about" | "focus" | "review" | "hire">("about");
  const [name, setName] = useState(company.name === "My Company" ? "" : company.name);
  const [description, setDescription] = useState("");
  const [stage, setStage] = useState("Seed");
  const [industry, setIndustry] = useState("");
  const [customer, setCustomer] = useState("");
  const [priorities, setPriorities] = useState<string[]>([]);
  const [teamContext, setTeamContext] = useState("");

  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<Set<number>>(new Set());
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(new Set());

  // Hiring sub-flow: pick 1-of-3 candidates for each selected role, one role at a time.
  const [hireIndex, setHireIndex] = useState(0);
  const [chosen, setChosen] = useState<ChosenRole[]>([]);
  const rolesToHire = suggestion ? suggestion.roles.filter((_, i) => selectedRoles.has(i)) : [];

  const togglePriority = (p: string) =>
    setPriorities((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const [runGenerate, { busy: generating, error: generateError }] = useAsyncAction(async () => {
    const s = await command<Suggestion>(
      "onboarding.generate",
      { companyName: name, description, stage, industry, customer, priorities, teamContext },
      company.id,
    );
    setSuggestion(s);
    setSystemPrompt(s.systemPrompt);
    setSelectedRoles(new Set(s.roles.map((_, i) => i)));
    setSelectedChannels(new Set(s.channels.map((_, i) => i)));
  });

  const generate = () => {
    setStep("review");
    runGenerate();
  };

  const [runFinish, { busy: applying, error: finishError }] = useAsyncAction(async (roles: ChosenRole[]) => {
    const { conversationIds } = await command<{ ok: true; conversationIds: string[] }>(
      "onboarding.apply",
      {
        companyName: name.trim() || "My Company",
        profile: suggestion?.profile ?? company.profile,
        systemPrompt,
        roles,
        channels: suggestion ? suggestion.channels.filter((_, i) => selectedChannels.has(i)) : [],
      },
      company.id,
    );
    onDone(conversationIds);
  });

  // Leaving the review step: if any roles are selected, walk the founder through
  // picking a candidate for each; otherwise finalize immediately (no hires).
  const startHiring = () => {
    if (rolesToHire.length === 0) {
      runFinish([]);
      return;
    }
    setChosen([]);
    setHireIndex(0);
    setStep("hire");
  };

  const [runPickCandidate, { error: pickError }] = useAsyncAction(async (candidate: FullCandidate) => {
    const role = rolesToHire[hireIndex];
    let avatar: string | null;
    try {
      avatar = await urlToResizedDataUrl(candidate.photoUrl);
    } catch {
      avatar = null; // a missing avatar shouldn't block the hire
    }
    const next = [...chosen];
    next[hireIndex] = {
      jobTitle: role.jobTitle,
      department: role.department,
      name: candidate.name,
      avatar,
      mission: candidate.mission,
      preamble: candidate.preamble,
      additionalDetails: candidate.additionalDetails,
      responsibilities: candidate.responsibilities,
      personality: candidate.personality,
      communicationStyle: candidate.communicationStyle,
      expertise: candidate.expertise,
    };
    setChosen(next);
    if (hireIndex + 1 < rolesToHire.length) {
      setHireIndex(hireIndex + 1);
    } else {
      await runFinish(next);
    }
  });

  const [runSkip, { busy: skipping, error: skipError }] = useAsyncAction(async () => {
    const trimmedName = name.trim() || company.name;
    await command("company.update", { companyId: company.id, field: "name", value: trimmedName }, null);
    // mark onboarded without hires
    await command(
      "onboarding.apply",
      { companyName: trimmedName, profile: company.profile, systemPrompt: company.system_prompt, roles: [], channels: [] },
      company.id,
    );
    onDone([]);
  });

  return (
    <div className="modal-scrim">
      <div className="modal onboarding-modal" onClick={(e) => e.stopPropagation()}>
        <div className="onboarding-head">
          <h2>Set up your company</h2>
          <div className="onboarding-steps">
            <span className={step === "about" ? "on" : ""}>1 · About</span>
            <span className={step === "focus" ? "on" : ""}>2 · Focus</span>
            <span className={step === "review" || step === "hire" ? "on" : ""}>3 · Team</span>
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
              <button className="settings-link-btn" disabled={skipping} onClick={runSkip}>
                {skipping ? "Skipping…" : "Skip for now"}
              </button>
              <button className="settings-save-btn" disabled={!description.trim()} onClick={() => setStep("focus")}>Next</button>
            </div>
            {skipError && <p className="form-error">{skipError}</p>}
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
            ) : generateError ? (
              // Previously this branch rendered nothing at all — a dead-end blank screen
              // with no error and no way back or to retry (report §5.1).
              <div className="onboarding-generating">
                <p className="form-error">Couldn't generate your company: {generateError}</p>
                <div className="onboarding-actions">
                  <button className="settings-link-btn" onClick={() => setStep("focus")}>Back</button>
                  <button className="settings-save-btn" onClick={runGenerate}>Retry</button>
                </div>
              </div>
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
                      <input
                        type="checkbox"
                        checked={selectedRoles.has(i)}
                        onChange={() =>
                          setSelectedRoles((prev) => {
                            const n = new Set(prev);
                            if (n.has(i)) n.delete(i);
                            else n.add(i);
                            return n;
                          })
                        }
                      />
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
                        <button
                          key={c}
                          className={`onboarding-chip ${selectedChannels.has(i) ? "on" : ""}`}
                          onClick={() =>
                            setSelectedChannels((prev) => {
                              const n = new Set(prev);
                              if (n.has(i)) n.delete(i);
                              else n.add(i);
                              return n;
                            })
                          }
                        >
                          #{c}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="onboarding-actions">
                  <button className="settings-link-btn" onClick={() => setStep("focus")}>Back</button>
                  <button className="settings-save-btn" disabled={applying} onClick={startHiring}>
                    {applying ? "Setting up…" : rolesToHire.length > 0 ? `Meet your candidates (${rolesToHire.length}) →` : "Finish setup"}
                  </button>
                </div>
                {finishError && <p className="form-error">{finishError}</p>}
              </>
            ) : null}
          </div>
        )}

        {step === "hire" && rolesToHire.length > 0 && (
          <div className="onboarding-body">
            <div className="onboarding-hire-progress">
              Hiring {Math.min(hireIndex + 1, rolesToHire.length)} of {rolesToHire.length}
              {applying && " · finalizing…"}
            </div>
            <CandidatePicker
              key={hireIndex}
              companyId={company.id}
              jobTitle={rolesToHire[hireIndex].jobTitle}
              department={rolesToHire[hireIndex].department}
              onPick={runPickCandidate}
              picking={applying}
            />
            <div className="onboarding-actions">
              <button
                className="settings-link-btn"
                disabled={applying}
                onClick={() => (hireIndex > 0 ? setHireIndex(hireIndex - 1) : setStep("review"))}
              >
                Back
              </button>
            </div>
            {(pickError || finishError) && <p className="form-error">{pickError || finishError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
