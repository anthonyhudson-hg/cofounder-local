import { Check, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useCreateEmployee } from "../hooks/useCreateEmployee";
import { useDepartments } from "../hooks/useDepartments";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { Candidate, fetchCandidates } from "../lib/randomUser";
import { DEFAULT_DEPARTMENT_SUGGESTIONS, Employee } from "../types";

interface Props {
  companyId: string | null;
  employees: Employee[];
  onCreated: (conversationId: string) => void;
  onClose: () => void;
}

type Mode = "search" | "browse";

export function HireModal({ companyId, employees, onCreated, onClose }: Props) {
  const [step, setStep] = useState<"intent" | "candidates">("intent");
  const [mode, setMode] = useState<Mode>("search");
  const [searchText, setSearchText] = useState("");
  const [department, setDepartment] = useState<string | null>(null);

  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [addingDepartment, setAddingDepartment] = useState(false);
  const [newDepartmentName, setNewDepartmentName] = useState("");

  const { create } = useCreateEmployee(companyId);
  const { departments, create: createDepartment } = useDepartments(companyId);

  const departmentOptions = Array.from(
    new Set([...departments.map((d) => d.name), ...DEFAULT_DEPARTMENT_SUGGESTIONS]),
  );

  const countsByDepartment = new Map<string, number>();
  for (const e of employees) {
    countsByDepartment.set(e.department, (countsByDepartment.get(e.department) ?? 0) + 1);
  }

  const handleConfirmNewDepartment = async () => {
    const trimmed = newDepartmentName.trim();
    setAddingDepartment(false);
    setNewDepartmentName("");
    if (!trimmed) return;
    await createDepartment(trimmed);
    setDepartment(trimmed);
  };

  // While a new department is being typed, Next stays disabled instead of racing the
  // blur-triggered create against a direct click on Next (report §5.9) — the user must
  // explicitly commit the new department (Enter / confirm button / blur) first, which
  // flips `addingDepartment` false and unlocks Next with `department` already set.
  const canProceed = mode === "search" ? searchText.trim().length > 0 : !addingDepartment && !!department;

  useEffect(() => {
    if (step !== "candidates" || candidates) return;
    let cancelled = false;
    setLoadError(null);
    fetchCandidates(54)
      .then((results) => {
        if (!cancelled) setCandidates(results);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [step, candidates, loadAttempt]);

  const retryLoadCandidates = useCallback(() => {
    setLoadError(null);
    setLoadAttempt((n) => n + 1);
  }, []);

  const [runPick, { busy: picking, error: pickError }, clearPickError] = useAsyncAction(
    async (candidate: Candidate) => {
      const { conversationId } = await create({
        name: candidate.name,
        photoUrl: candidate.photoUrl,
        jobTitle: mode === "search" ? searchText.trim() : "",
        department: mode === "browse" ? department ?? "" : "",
      });
      onCreated(conversationId);
    },
  );
  const [pickingName, setPickingName] = useState<string | null>(null);

  const handlePick = async (candidate: Candidate) => {
    if (pickingName) return;
    setPickingName(candidate.name);
    clearPickError();
    await runPick(candidate);
    setPickingName(null);
  };

  useEscapeToClose(true, onClose);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal hire-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Hire a new employee</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>

        {step === "intent" && (
          <div className="hire-step">
            <p className="hire-step-prompt">What are you hiring for?</p>

            <div className="hire-mode-toggle">
              <button
                className={`hire-mode-btn ${mode === "search" ? "active" : ""}`}
                onClick={() => setMode("search")}
              >
                Describe what I need
              </button>
              <button
                className={`hire-mode-btn ${mode === "browse" ? "active" : ""}`}
                onClick={() => setMode("browse")}
              >
                Browse departments
              </button>
            </div>

            {mode === "search" ? (
              <input
                autoFocus
                className="hire-search-input"
                placeholder="e.g. someone to own customer support"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />
            ) : (
              <div className="hire-department-grid">
                {departmentOptions.map((d) => (
                  <button
                    key={d}
                    className={`hire-department-card ${department === d ? "active" : ""}`}
                    onClick={() => setDepartment(d)}
                  >
                    <span className="hire-department-name">{d}</span>
                    <span className="hire-department-count">
                      {countsByDepartment.get(d) ?? 0} hired
                    </span>
                  </button>
                ))}
                {addingDepartment ? (
                  <div className="hire-department-card hire-department-card-new">
                    <input
                      autoFocus
                      className="hire-department-new-input"
                      placeholder="New department"
                      value={newDepartmentName}
                      onChange={(e) => setNewDepartmentName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleConfirmNewDepartment();
                        } else if (e.key === "Escape") {
                          setAddingDepartment(false);
                          setNewDepartmentName("");
                        }
                      }}
                      onBlur={handleConfirmNewDepartment}
                    />
                    <button
                      type="button"
                      className="settings-icon-btn"
                      title="Confirm department"
                      aria-label="Confirm department"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={handleConfirmNewDepartment}
                    >
                      <Check />
                    </button>
                  </div>
                ) : (
                  <button
                    className="hire-department-card hire-department-card-add"
                    onClick={() => setAddingDepartment(true)}
                  >
                    <span className="hire-department-name">+ Add department</span>
                  </button>
                )}
              </div>
            )}

            <div className="settings-save-row">
              <button
                className="settings-save-btn"
                disabled={!canProceed}
                onClick={() => setStep("candidates")}
              >
                Next
              </button>
            </div>
          </div>
        )}

        {step === "candidates" && (
          <div className="hire-step">
            <p className="hire-step-prompt">Pick a candidate</p>
            {loadError && (
              <div className="hire-error">
                Couldn't load candidates: {loadError}{" "}
                <button className="settings-link-btn" onClick={retryLoadCandidates}>
                  Retry
                </button>
              </div>
            )}
            {!candidates && !loadError && <div className="hire-loading">Finding candidates…</div>}
            {candidates && (
              <div className="hire-candidate-grid">
                {candidates.map((c) => (
                  <button
                    key={c.name}
                    className="hire-candidate-card"
                    disabled={!!pickingName || picking}
                    onClick={() => handlePick(c)}
                  >
                    <img className="hire-candidate-photo" src={c.photoUrl} alt={c.name} />
                    <span className="hire-candidate-name">{c.name}</span>
                    {pickingName === c.name && <span className="hire-candidate-hiring">Hiring…</span>}
                  </button>
                ))}
              </div>
            )}
            {pickError && <p className="form-error">Couldn't hire: {pickError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
