import { ArrowsClockwise } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { command } from "../lib/runtimeClient";
import { FullCandidate, PersonaCandidate, zipCandidates } from "../lib/candidates";
import { fetchCandidates } from "../lib/randomUser";

interface Props {
  companyId: string | null;
  jobTitle: string;
  department: string;
  onPick: (candidate: FullCandidate) => void | Promise<void>;
  /** External busy flag (e.g. the parent is finalizing) — disables picking. */
  picking?: boolean;
  count?: number;
}

/**
 * The shared "pick 1 of N candidates" step used by both the Hire flow and onboarding.
 * Generates N fully-populated personas for a role (runtime `candidates.generate`) and
 * pairs each with a silly name + gender-matched photo, then renders rich cards.
 */
export function CandidatePicker({ companyId, jobTitle, department, onPick, picking, count = 3 }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [busyName, setBusyName] = useState<string | null>(null);
  // Result is tagged with the request `key` it was loaded for; anything stale (a
  // different role, or a pending regenerate) reads as "still loading" without a
  // synchronous reset inside the effect.
  const requestKey = `${companyId}|${jobTitle}|${department}|${count}|${attempt}`;
  const [loaded, setLoaded] = useState<{ key: string; candidates: FullCandidate[] | null; error: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      command<PersonaCandidate[]>("candidates.generate", { jobTitle, department, count }, companyId),
      fetchCandidates(count),
    ])
      .then(([personas, bases]) => {
        if (!cancelled) setLoaded({ key: requestKey, candidates: zipCandidates(personas, bases), error: null });
      })
      .catch((err) => {
        if (!cancelled) setLoaded({ key: requestKey, candidates: null, error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, companyId, jobTitle, department, count]);

  const current = loaded && loaded.key === requestKey ? loaded : null;
  const candidates = current?.candidates ?? null;
  const loadError = current?.error ?? null;

  const regenerate = useCallback(() => setAttempt((n) => n + 1), []);

  const handlePick = async (c: FullCandidate) => {
    if (busyName || picking) return;
    setBusyName(c.name);
    try {
      await onPick(c);
    } finally {
      setBusyName(null);
    }
  };

  const disabled = !!busyName || !!picking;

  return (
    <div className="candidate-picker">
      <div className="candidate-picker-head">
        <p className="hire-step-prompt">
          Pick a candidate for <strong>{jobTitle}</strong>
        </p>
        {candidates && (
          <button className="settings-link-btn candidate-regen" onClick={regenerate} disabled={disabled}>
            <ArrowsClockwise /> Regenerate
          </button>
        )}
      </div>

      {loadError && (
        <div className="hire-error">
          Couldn't generate candidates: {loadError}{" "}
          <button className="settings-link-btn" onClick={regenerate}>
            Retry
          </button>
        </div>
      )}
      {!candidates && !loadError && <div className="hire-loading">Generating candidates…</div>}

      {candidates && (
        <div className="candidate-grid">
          {candidates.map((c) => (
            <button
              key={c.name}
              className="candidate-card"
              disabled={disabled}
              onClick={() => handlePick(c)}
            >
              <div className="candidate-card-head">
                <img className="candidate-photo" src={c.photoUrl} alt={c.name} />
                <div className="candidate-ident">
                  <span className="candidate-name">{c.name}</span>
                  <span className="candidate-label">{c.personalityLabel}</span>
                </div>
              </div>
              {c.summary && <p className="candidate-summary">{c.summary}</p>}
              {c.mission && <p className="candidate-mission">{c.mission}</p>}
              {c.responsibilities.length > 0 && (
                <ul className="candidate-responsibilities">
                  {c.responsibilities.slice(0, 3).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              <span className="candidate-cta">{busyName === c.name ? "Hiring…" : "Hire"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
