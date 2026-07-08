import { Camera, CaretRight, Check, DiceFive, Hash, Plus, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { descendantIds } from "../lib/orgChart";
import { buildIdentityBlock, composeSystemPrompt, resolveManagerName } from "../lib/promptBuilder";
import { randomSillyName } from "../lib/sillyNames";
import {
  AUTONOMY_HINTS,
  AUTONOMY_LABELS,
  AUTONOMY_LEVELS,
  AutonomyLevel,
  CAPABILITY_EFFECTS,
  CAPABILITY_EFFECT_LABELS,
  CapabilityEffect,
  Conversation,
  EFFORTS,
  Effort,
  Employee,
  MODELS,
  PROVIDERS,
  PROVIDER_LABELS,
  Responsibility,
  scopeLabel,
} from "../types";
import { useAgentProfile } from "../hooks/useAgentProfile";
import { useCapabilities } from "../hooks/useCapabilities";
import { useChannelMembership } from "../hooks/useChannelMembership";
import { useDepartments } from "../hooks/useDepartments";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { usePhotoUpload } from "../hooks/usePhotoUpload";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { useResponsibilities } from "../hooks/useResponsibilities";
import { useTokenCount } from "../hooks/useTokenCount";
import { Avatar } from "./Avatar";
import { EmployeeInfo } from "./MessageList";

interface Props {
  conversation: Conversation;
  employee: Employee;
  channels: Conversation[];
  employees: Employee[];
  employeesById: Record<string, EmployeeInfo>;
  companyId: string;
  companyProfile: string;
  companySystemPrompt: string;
  userFullName: string;
  onRename: (name: string) => void;
  onUpdateField: <K extends keyof Employee>(field: K, value: Employee[K]) => void;
  onClose: () => void;
}

const NEW_DEPARTMENT_VALUE = "__new__";

function ResponsibilityRow({
  responsibility,
  onUpdate,
  onRemove,
}: {
  responsibility: Responsibility;
  onUpdate: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  const [text, setText] = useState(responsibility.text);

  // Resync on either id OR text changing — depending on id alone meant a canonical
  // text update from the server (same id) never propagated into the local draft (report §5.9).
  useEffect(() => {
    setText(responsibility.text);
  }, [responsibility.id, responsibility.text]);

  const commit = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      // Don't persist an emptied-out responsibility; reset the draft back to the last
      // saved value instead (report §5.9).
      setText(responsibility.text);
      return;
    }
    if (trimmed !== responsibility.text) onUpdate(responsibility.id, trimmed);
  };

  return (
    <div className="responsibility-row">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
      />
      <button
        className="responsibility-remove"
        title="Remove responsibility"
        aria-label="Remove responsibility"
        onClick={() => onRemove(responsibility.id)}
      >
        <X />
      </button>
    </div>
  );
}

export function EmployeeSettingsPanel({
  conversation,
  employee,
  channels,
  employees,
  employeesById,
  companyId,
  companyProfile,
  companySystemPrompt,
  userFullName,
  onRename,
  onUpdateField,
  onClose,
}: Props) {
  const { memberOf, toggle: toggleChannel } = useChannelMembership(employee.id);
  const { departments, create: createDepartment } = useDepartments(companyId);
  const { width, onMouseDown } = useResizableWidth(320, 280, 560, "left");
  const [name, setName] = useState(conversation.name);
  const [jobTitle, setJobTitle] = useState(employee.job_title);
  const [department, setDepartment] = useState(employee.department);
  const [addingDepartment, setAddingDepartment] = useState(false);
  const [newDepartmentName, setNewDepartmentName] = useState("");
  const [mission, setMission] = useState(employee.mission);
  const [preamble, setPreamble] = useState(employee.preamble);
  const [additionalDetails, setAdditionalDetails] = useState(employee.additional_details);
  const [savedFlash, setSavedFlash] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { responsibilities, add: addResponsibility, update: updateResponsibility, remove: removeResponsibility } =
    useResponsibilities(employee.id);
  const [newResponsibility, setNewResponsibility] = useState("");

  const { profile: agentProfile, loaded: agentProfileLoaded, updateField: updateAgentProfileField } =
    useAgentProfile(employee.id);
  const { scopes: capabilityScopes, grants: capabilityGrants, setEffect: setCapabilityEffect } =
    useCapabilities(companyId, employee.id);
  const [personality, setPersonality] = useState(agentProfile.personality);
  const [communicationStyle, setCommunicationStyle] = useState(agentProfile.communicationStyle);
  const [expertiseText, setExpertiseText] = useState(agentProfile.expertise.join(", "));

  useEffect(() => {
    setName(conversation.name);
    setJobTitle(employee.job_title);
    setDepartment(employee.department);
    setAddingDepartment(false);
    setNewDepartmentName("");
    setMission(employee.mission);
    setPreamble(employee.preamble);
    setAdditionalDetails(employee.additional_details);
  }, [conversation.id]);

  useEffect(() => {
    // Deliberately keyed on `agentProfileLoaded` flipping true, not on
    // `agentProfile` itself — the hook hands back a new object reference on
    // every reload, including right after autonomy_level's immediate-apply
    // update (see below), which would otherwise stomp an in-progress, unsaved
    // personality/communication-style/expertise edit the instant autonomy
    // level was changed via the (unrelated) select.
    if (!agentProfileLoaded) return;
    setPersonality(agentProfile.personality);
    setCommunicationStyle(agentProfile.communicationStyle);
    setExpertiseText(agentProfile.expertise.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id, agentProfileLoaded]);

  const managerName = resolveManagerName(employee.manager_employee_id, employeesById, userFullName);
  const identityBlock = buildIdentityBlock(
    name || conversation.name,
    { ...employee, job_title: jobTitle, department },
    managerName,
  );
  const injectedBefore = [companyProfile.trim(), companySystemPrompt.trim(), identityBlock.trim()]
    .filter(Boolean)
    .join("\n\n");
  const responsibilityTexts = responsibilities.map((r) => r.text);
  const expertiseList = expertiseText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fullPrompt = composeSystemPrompt(
    companyProfile,
    companySystemPrompt,
    identityBlock,
    { mission, preamble, additional_details: additionalDetails },
    responsibilityTexts,
    { personality, communicationStyle, expertise: expertiseList, autonomyLevel: agentProfile.autonomyLevel },
  );
  const { tokens, exact } = useTokenCount(fullPrompt, employee.default_model);

  const isDirty =
    name.trim() !== conversation.name ||
    jobTitle !== employee.job_title ||
    department !== employee.department ||
    mission !== employee.mission ||
    preamble !== employee.preamble ||
    additionalDetails !== employee.additional_details ||
    personality !== agentProfile.personality ||
    communicationStyle !== agentProfile.communicationStyle ||
    expertiseList.join(",") !== agentProfile.expertise.join(",");

  const departmentNames = departments.map((d) => d.name);
  const departmentOptions = departmentNames.includes(employee.department)
    ? departmentNames
    : [employee.department, ...departmentNames].filter(Boolean);

  // Exclude self and every transitive report (the whole reporting subtree, not just
  // direct reports) so the manager chain can't form a cycle at any depth (report §4.1).
  const excludedManagerIds = descendantIds(employee.id, employees);
  const managerOptions = employees.filter(
    (e) => e.id !== employee.id && !excludedManagerIds.has(e.id),
  );

  const handleDepartmentChange = (value: string) => {
    if (value === NEW_DEPARTMENT_VALUE) {
      setAddingDepartment(true);
      return;
    }
    setDepartment(value);
  };

  const handleConfirmNewDepartment = async () => {
    const trimmed = newDepartmentName.trim();
    if (!trimmed) {
      setAddingDepartment(false);
      return;
    }
    await createDepartment(trimmed);
    setDepartment(trimmed);
    setAddingDepartment(false);
    setNewDepartmentName("");
  };

  const handleSave = () => {
    if (name.trim() && name.trim() !== conversation.name) onRename(name.trim());
    if (jobTitle !== employee.job_title) onUpdateField("job_title", jobTitle);
    if (department !== employee.department) onUpdateField("department", department);
    if (mission !== employee.mission) onUpdateField("mission", mission);
    if (preamble !== employee.preamble) onUpdateField("preamble", preamble);
    if (additionalDetails !== employee.additional_details)
      onUpdateField("additional_details", additionalDetails);
    if (personality !== agentProfile.personality) updateAgentProfileField("personality", personality);
    if (communicationStyle !== agentProfile.communicationStyle)
      updateAgentProfileField("communicationStyle", communicationStyle);
    if (expertiseList.join(",") !== agentProfile.expertise.join(","))
      updateAgentProfileField("expertise", expertiseList);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  };

  const handlePickPhoto = () => fileInputRef.current?.click();

  const [runUpload, { busy: uploading, error: uploadError }] = usePhotoUpload((dataUrl) =>
    onUpdateField("avatar", dataUrl),
  );

  const handlePhotoSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await runUpload(file);
  };

  // Editing preamble/mission/details is real, easy-to-lose work — confirm before
  // discarding an unsaved edit on close (report §5.8).
  const requestClose = () => {
    if (isDirty && !window.confirm("You have unsaved changes. Discard them?")) return;
    onClose();
  };

  useEscapeToClose(true, requestClose);

  const handleAddResponsibility = () => {
    if (!newResponsibility.trim()) return;
    addResponsibility(newResponsibility.trim());
    setNewResponsibility("");
  };

  return (
    <aside className="settings-panel" style={{ width }}>
      <div className="resize-handle resize-handle-left" onMouseDown={onMouseDown} />
      <div className="settings-panel-header">
        <h3>Employee settings</h3>
        <button className="modal-close" aria-label="Close" onClick={requestClose}>
          <X />
        </button>
      </div>

      <div className="settings-panel-body">
        <div className="settings-hero">
          <div className="settings-hero-avatar-wrap">
            <Avatar name={name} avatar={employee.avatar} bot className="settings-avatar" />
            <button
              className="settings-avatar-edit-btn"
              title="Change photo"
              aria-label="Change photo"
              onClick={handlePickPhoto}
              disabled={uploading}
            >
              <Camera weight="fill" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={handlePhotoSelected}
            />
          </div>
          <div className="settings-hero-fields">
            <div className="settings-input-with-btn">
              <input
                className="settings-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
              />
              <button
                className="settings-icon-btn"
                title="Randomize name"
                aria-label="Randomize name"
                onClick={() => setName(randomSillyName(name))}
              >
                <DiceFive />
              </button>
            </div>
            <input
              className="settings-title-input"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="Job title"
            />
            {uploading && <span className="settings-hint">Uploading photo…</span>}
            {uploadError && <p className="form-error">Couldn't upload photo: {uploadError}</p>}
            {employee.avatar && !uploading && (
              <button className="settings-link-btn danger" onClick={() => onUpdateField("avatar", null)}>
                Remove photo
              </button>
            )}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Role</div>

          <label className="settings-field">
            <span className="settings-label">Department</span>
            {addingDepartment ? (
              <div className="settings-input-with-btn">
                <input
                  autoFocus
                  value={newDepartmentName}
                  placeholder="New department name"
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
                  className="settings-icon-btn"
                  title="Add department"
                  aria-label="Add department"
                  onClick={handleConfirmNewDepartment}
                >
                  <Check />
                </button>
              </div>
            ) : (
              <select value={department} onChange={(e) => handleDepartmentChange(e.target.value)}>
                {departmentOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
                <option value={NEW_DEPARTMENT_VALUE}>+ Add new department…</option>
              </select>
            )}
          </label>

          <label className="settings-field">
            <span className="settings-label">Reporting manager</span>
            <select
              value={employee.manager_employee_id ?? ""}
              onChange={(e) => onUpdateField("manager_employee_id", e.target.value || null)}
            >
              <option value="">{userFullName || "You"} (founder)</option>
              {managerOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {employeesById[m.id]?.name ?? m.job_title}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Model</div>

          <div className="settings-field-row">
            <label className="settings-field">
              <span className="settings-label">Default model</span>
              <select value={employee.default_model} onChange={(e) => onUpdateField("default_model", e.target.value)}>
                {PROVIDERS.map((p) => (
                  <optgroup key={p} label={PROVIDER_LABELS[p]}>
                    {MODELS.filter((m) => m.provider === p).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>

            <label className="settings-field">
              <span className="settings-label">Default effort</span>
              <select
                value={employee.default_effort}
                onChange={(e) => onUpdateField("default_effort", e.target.value as Effort)}
              >
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {e[0].toUpperCase() + e.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Channels</div>
          <div className="channel-chip-list">
            {channels.map((c) => {
              const active = memberOf.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`channel-chip ${active ? "active" : ""}`}
                  onClick={() => toggleChannel(c.id)}
                >
                  {active && <Check size={12} weight="bold" />}
                  <Hash size={12} weight="bold" />
                  {c.name}
                </button>
              );
            })}
          </div>
          <span className="settings-hint">
            Only channels this employee is a member of will see their messages — and only members are asked
            whether to respond.
          </span>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Behavior</div>

          <label className="settings-field">
            <span className="settings-label">Mission</span>
            <input value={mission} onChange={(e) => setMission(e.target.value)} placeholder="One-line mission" />
          </label>

          <label className="settings-field">
            <span className="settings-label">Preamble</span>
            <textarea
              value={preamble}
              rows={7}
              onChange={(e) => setPreamble(e.target.value)}
              placeholder="The main narrative describing how this employee thinks and acts"
            />
          </label>

          <div className="settings-field">
            <span className="settings-label">Responsibilities</span>
            <div className="responsibilities-list">
              {responsibilities.map((r) => (
                <ResponsibilityRow
                  key={r.id}
                  responsibility={r}
                  onUpdate={updateResponsibility}
                  onRemove={removeResponsibility}
                />
              ))}
              <div className="responsibility-row responsibility-add-row">
                <input
                  placeholder="Add a responsibility…"
                  value={newResponsibility}
                  onChange={(e) => setNewResponsibility(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddResponsibility();
                    }
                  }}
                />
                <button
                  className="responsibility-add"
                  title="Add responsibility"
                  aria-label="Add responsibility"
                  onClick={handleAddResponsibility}
                >
                  <Plus />
                </button>
              </div>
            </div>
          </div>

          <label className="settings-field">
            <span className="settings-label settings-label-row">
              <span>Additional details</span>
              <span className="settings-token-count">
                {tokens == null
                  ? "…"
                  : `${exact ? "" : "~"}${tokens.toLocaleString()} tokens${exact ? "" : " est."} (full prompt)`}
              </span>
            </span>
            <textarea
              value={additionalDetails}
              rows={5}
              onChange={(e) => setAdditionalDetails(e.target.value)}
              placeholder="Anything else — decision rights, KPIs, escalation paths, handoffs, etc."
            />
          </label>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Personality &amp; autonomy</div>

          <label className="settings-field">
            <span className="settings-label">Personality</span>
            <textarea
              value={personality}
              rows={3}
              onChange={(e) => setPersonality(e.target.value)}
              placeholder="How this employee comes across — e.g. blunt and dry, warm and encouraging, methodical"
            />
          </label>

          <label className="settings-field">
            <span className="settings-label">Communication style</span>
            <input
              value={communicationStyle}
              onChange={(e) => setCommunicationStyle(e.target.value)}
              placeholder="e.g. short messages, bullet points over prose, asks clarifying questions first"
            />
          </label>

          <label className="settings-field">
            <span className="settings-label">Areas of expertise</span>
            <input
              value={expertiseText}
              onChange={(e) => setExpertiseText(e.target.value)}
              placeholder="Comma-separated, e.g. fundraising, hiring, distributed systems"
            />
          </label>

          <label className="settings-field">
            <span className="settings-label">Autonomy level</span>
            <select
              value={agentProfile.autonomyLevel}
              onChange={(e) => updateAgentProfileField("autonomyLevel", e.target.value as AutonomyLevel)}
            >
              {AUTONOMY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {AUTONOMY_LABELS[level]}
                </option>
              ))}
            </select>
            <span className="settings-hint">{AUTONOMY_HINTS[agentProfile.autonomyLevel]}</span>
          </label>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Permissions</div>
          {capabilityScopes.length === 0 ? (
            <span className="settings-hint">No tools are registered yet.</span>
          ) : (
            capabilityScopes.map((s) => {
              const current = capabilityGrants.find((g) => g.scope === s.scope)?.maxEffect ?? "none";
              const maxIdx = CAPABILITY_EFFECTS.indexOf(s.maxEffect);
              return (
                <label className="settings-field" key={s.scope}>
                  <span className="settings-label">{scopeLabel(s.scope)}</span>
                  <select
                    value={current}
                    onChange={(e) => setCapabilityEffect(s.scope, e.target.value as CapabilityEffect)}
                  >
                    {CAPABILITY_EFFECTS.slice(0, maxIdx + 1).map((eff) => (
                      <option key={eff} value={eff}>
                        {CAPABILITY_EFFECT_LABELS[eff]}
                      </option>
                    ))}
                  </select>
                  <span className="settings-hint">Used by: {s.tools.join(", ")}</span>
                </label>
              );
            })
          )}
          <span className="settings-hint">
            Without a grant, this employee can't use a tool at all — a chat request just gets a clean denial.
            Requests beyond the grant here still ask for your approval before running.
          </span>
        </div>

        <details className="settings-section settings-advanced">
          <summary className="settings-section-title settings-advanced-summary">
            <CaretRight className="settings-advanced-caret" size={11} weight="bold" />
            Injected before this employee's prompt
          </summary>
          <pre className="debug-pre injected-preview">{injectedBefore || "(nothing yet)"}</pre>
          <span className="settings-hint">
            Company profile + company system prompt (Company settings) + this employee's identity block,
            composed fresh from live values every time — not stored combined.
          </span>
        </details>
      </div>

      <div className="settings-save-row">
        <button className="settings-save-btn" disabled={!isDirty} onClick={handleSave}>
          Save changes
        </button>
        {savedFlash && <span className="settings-saved-flash">Saved</span>}
        {isDirty && !savedFlash && <span className="settings-dirty-flash">Unsaved changes</span>}
      </div>
    </aside>
  );
}
