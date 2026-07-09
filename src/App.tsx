import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { AppSettingsModal } from "./components/AppSettingsModal";
import { ChatPane } from "./components/ChatPane";
import { EmployeeSettingsPanel } from "./components/EmployeeSettingsPanel";
import { CompanySwitcher } from "./components/CompanySwitcher";
import { GroupModal } from "./components/GroupModal";
import { HireModal } from "./components/HireModal";
import { HomeView } from "./components/HomeView";
import { IconRail, RailView } from "./components/IconRail";
import { EmployeeInfo } from "./components/MessageList";
import { OnboardingModal } from "./components/OnboardingModal";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { ProviderSetupGate } from "./components/ProviderSetupGate";
import { OrgChartView } from "./components/OrgChartView";
import { ProjectsView } from "./components/ProjectsView";
import { TasksView } from "./components/TasksView";
import { GlobalSearch } from "./components/GlobalSearch";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { useActiveCompany } from "./hooks/useActiveCompany";
import { useCompanies } from "./hooks/useCompanies";
import { useConversationActivity } from "./hooks/useConversationActivity";
import { useConversations } from "./hooks/useConversations";
import { useCreateGroup } from "./hooks/useCreateGroup";
import { useDesktopNotifications } from "./hooks/useDesktopNotifications";
import { useEmployee } from "./hooks/useEmployee";
import { useEmployees } from "./hooks/useEmployees";
import { useNotificationPreference } from "./hooks/useNotificationPreference";
import { useProviderHealth } from "./hooks/useProviderHealth";
import { useStartupErrors } from "./hooks/useStartupErrors";
import { useUpdateChecker } from "./hooks/useUpdateChecker";
import { useUserProfile } from "./hooks/useUserProfile";
import { setActiveCompanyId } from "./lib/activeCompany";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { command } from "./lib/runtimeClient";
import { ensureNotificationWindow, onNotificationOpen } from "./lib/notificationPopup";
import { MessageTarget } from "./lib/search";
import { applyTheme, themeForColor } from "./lib/themes";
import { ProviderAvailabilityContext } from "./lib/providerAvailability";
import { Employee, Provider } from "./types";

export default function App() {
  const {
    company,
    loaded: companyLoaded,
    updateField: updateCompanyField,
    reload: reloadCompany,
  } = useActiveCompany();
  const companyId = company?.id ?? null;

  const { companies, create: createCompany, clone: cloneCompany, remove: removeCompany } = useCompanies();

  const { channels, dms, loaded, rename, reload: reloadConversations } = useConversations(companyId);
  const [view, setView] = useState<RailView>("chats");
  const [activeId, setActiveId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  // A message the user jumped to from global search — consumed by ChatPane to
  // scroll/highlight it (and open its thread). Null once handled.
  const [searchFocus, setSearchFocus] = useState<MessageTarget | null>(null);
  // GlobalSearch assigns its focus() here so the sidebar search button can focus it.
  const searchFocusRef = useRef<(() => void) | null>(null);
  const [hireOpen, setHireOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  // DMs created this session (via onboarding) that have no messages yet. Without this
  // they'd be filtered out of the sidebar's DM list until first messaged, making a
  // freshly-hired cohort look like it was never created.
  const [freshDmIds, setFreshDmIds] = useState<Set<string>>(new Set());

  const { employee, updateField: updateEmployeeField, reload: reloadEmployee } = useEmployee(activeId || null);
  const { employees, reload: reloadEmployees } = useEmployees(companyId);
  const { userFullName, setUserFullName, loaded: profileLoaded } = useUserProfile();
  const { activeIds: conversationsWithMessages, reload: reloadActivity } = useConversationActivity(companyId);
  const { create: createGroup } = useCreateGroup(companyId);
  const {
    enabled: notificationsEnabled,
    setEnabled: setNotificationsEnabled,
    loaded: notificationPrefLoaded,
  } = useNotificationPreference();
  const startupError = useStartupErrors();
  const {
    health: providerHealth,
    loading: providerHealthLoading,
    error: providerHealthError,
    recheck: recheckProviders,
  } = useProviderHealth();
  const update = useUpdateChecker();

  // Providers actually connected on this machine, for graying out unavailable
  // models in every picker. null = unknown (health unresolved or errored) →
  // pickers don't gray anything out.
  const availableProviders = useMemo<Provider[] | null>(() => {
    if (!providerHealth || providerHealth.providers.length === 0) return null;
    return providerHealth.providers.filter((p) => p.available).map((p) => p.provider);
  }, [providerHealth]);

  // Apply the active company's theme across the whole UI; re-applies on switch.
  useEffect(() => {
    applyTheme(themeForColor(company?.color));
  }, [company?.color]);

  // Once a provider is confirmed available, repoint any employee whose model
  // belongs to a now-unavailable provider (chiefly the Chief of Staff, which is
  // seeded at first boot before the user has configured anything) onto an
  // available one. Idempotent and a no-op in the common case; reloads only if it
  // actually changed something.
  const [providersReconciled, setProvidersReconciled] = useState(false);
  useEffect(() => {
    if (!providerHealth?.anyAvailable || providersReconciled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await command<{ updated: number }>("providers.reconcile", {}, null);
        if (!cancelled && res.updated > 0) {
          await Promise.all([reloadConversations(), reloadEmployees(), reloadEmployee()]);
        }
      } catch {
        // Best-effort — send-time errors remain the backstop.
      } finally {
        if (!cancelled) setProvidersReconciled(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerHealth?.anyAvailable]);

  // Land on the Chief of Staff DM (the primary interface) so its started
  // conversation is on screen; fall back to the first channel.
  useEffect(() => {
    if (activeId) return;
    const cos = dms.find((d) => d.name === "Chief of Staff");
    if (cos) setActiveId(cos.id);
    else if (channels.length > 0) setActiveId(channels[0].id);
  }, [activeId, dms, channels]);

  // Reset the selected conversation whenever the active company changes so no
  // stale conversation/employee from the previous company leaks into the pane.
  useEffect(() => {
    setActiveId("");
    setFreshDmIds(new Set());
  }, [companyId]);

  const handleSwitchCompany = async (id: string) => {
    await setActiveCompanyId(id);
    setActiveId("");
    await reloadCompany();
  };

  const handleCloneCompany = async () => {
    if (!company) throw new Error("No active company");
    return cloneCompany(company.id, `${company.name} copy`);
  };

  const handleDeleteCompany = async () => {
    if (!company) return;
    const fallbackId = await removeCompany(company.id);
    setAppSettingsOpen(false);
    await handleSwitchCompany(fallbackId);
  };

  const handleCreateChannel = async (name: string) => {
    const res = await command<{ conversationId: string }>("channel.create", { name }, companyId);
    await reloadConversations();
    setActiveId(res.conversationId);
  };

  // Navigate to a conversation from global search, keeping message-less DMs visible.
  const revealConversation = (conversationId: string) => {
    setView("chats");
    setActiveId(conversationId);
    setFreshDmIds((prev) => (prev.has(conversationId) ? prev : new Set(prev).add(conversationId)));
  };
  const handleSelectConversation = (conversationId: string) => {
    revealConversation(conversationId);
    setSearchFocus(null);
  };
  const handleSelectMessage = (target: MessageTarget) => {
    revealConversation(target.conversationId);
    setSearchFocus(target);
  };

  // Registered here (after handleSelectMessage exists) so a clicked notification can
  // jump to its message. Hook order stays stable across renders — its position among
  // plain consts is irrelevant to the Rules of Hooks.
  useDesktopNotifications(notificationsEnabled, activeId, handleSelectMessage);

  // The custom notification popup lives in its own window; when the user clicks its
  // "Open" action, focus the main window and jump to the message.
  useEffect(() => {
    void ensureNotificationWindow().catch(() => {});
    let unlisten: (() => void) | undefined;
    onNotificationOpen((target) => {
      const win = getCurrentWindow();
      win.unminimize().catch(() => {});
      win.setFocus().catch(() => {});
      handleSelectMessage(target);
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!companyLoaded || !loaded || !profileLoaded) {
    return (
      <div className="app-root">
        <TitleBar />
        {startupError && <div className="startup-error-banner">{startupError}</div>}
        <div className="app-loading">Loading...</div>
      </div>
    );
  }

  // The health query itself failed (runtime unresponsive / timed out). Do NOT
  // fail open into onboarding that would then die on the first message — surface
  // a retryable error instead. (Distinct from the startup-error banner, which
  // only covers the runtime failing to SPAWN.)
  if (providerHealthError) {
    return (
      <div className="app-root">
        <TitleBar />
        {startupError && <div className="startup-error-banner">{startupError}</div>}
        <div className="modal-scrim">
          <div className="modal provider-gate">
            <div className="modal-header">
              <h3>Couldn't check model providers</h3>
            </div>
            <div className="debug-body">
              <p className="settings-hint">
                The background runtime didn't respond, so Cofounder can't confirm a model provider is
                connected. It may still be starting up, or it may have stopped. Retry in a moment.
              </p>
              <div className="provider-gate-detail" title={providerHealthError}>
                {providerHealthError}
              </div>
              <div className="settings-save-row">
                <button className="settings-save-btn" disabled={providerHealthLoading} onClick={recheckProviders}>
                  {providerHealthLoading ? "Checking…" : "Retry"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Health check still in flight. Its own screen (not the bare "Loading…") so
  // the — occasionally multi-second — provider ping reads as deliberate.
  if (!providerHealth) {
    return (
      <div className="app-root">
        <TitleBar />
        {startupError && <div className="startup-error-banner">{startupError}</div>}
        <div className="app-loading">Checking model providers…</div>
      </div>
    );
  }

  // Fail fast: no authenticated AI provider means not a single employee turn can
  // run, so gate the whole app (before onboarding) on setting one up rather than
  // letting the user hit an opaque failure on their first message.
  if (!providerHealth.anyAvailable) {
    return (
      <div className="app-root">
        <TitleBar />
        {startupError && <div className="startup-error-banner">{startupError}</div>}
        <ProviderSetupGate
          providers={providerHealth.providers}
          loading={providerHealthLoading}
          onRecheck={recheckProviders}
        />
      </div>
    );
  }

  if (!userFullName) {
    return (
      <div className="app-root">
        <TitleBar />
        {startupError && <div className="startup-error-banner">{startupError}</div>}
        <OnboardingModal onSubmit={setUserFullName} />
      </div>
    );
  }

  if (!company) {
    return (
      <div className="app-root">
        <TitleBar />
        {startupError && <div className="startup-error-banner">{startupError}</div>}
        <div className="app-loading">No company set up yet.</div>
      </div>
    );
  }

  if (company.onboarded === 0) {
    return (
      <div className="app-root">
        <TitleBar>{company.name}</TitleBar>
        {startupError && <div className="startup-error-banner">{startupError}</div>}
        <OnboardingWizard
          company={company}
          onDone={async (newDmConversationIds) => {
            await reloadCompany();
            await reloadConversations();
            await reloadEmployees();
            // Keep the just-hired employees visible in the sidebar even though their
            // DMs have no messages yet, and drop the user into the first one.
            if (newDmConversationIds.length > 0) {
              setFreshDmIds(new Set(newDmConversationIds));
              setActiveId(newDmConversationIds[0]);
            }
          }}
        />
      </div>
    );
  }

  const allConversations = [...channels, ...dms];
  const active = allConversations.find((c) => c.id === activeId) ?? channels[0];
  const avatarByConversationId: Record<string, string | null> = {};
  for (const e of employees) {
    avatarByConversationId[e.conversation_id] = e.avatar;
  }

  const visibleDms = dms.filter(
    (c) => c.id === activeId || conversationsWithMessages.has(c.id) || freshDmIds.has(c.id),
  );

  const employeesById: Record<string, EmployeeInfo> = {};
  for (const emp of employees) {
    const conv = allConversations.find((c) => c.id === emp.conversation_id);
    if (conv) employeesById[emp.id] = { name: conv.name, avatar: emp.avatar };
  }

  const dmMeta: Record<string, { employeeId: string; jobTitle: string }> = {};
  for (const emp of employees) {
    dmMeta[emp.conversation_id] = { employeeId: emp.id, jobTitle: emp.job_title };
  }

  const handleUpdateEmployeeField = async <K extends keyof Employee>(field: K, value: Employee[K]) => {
    await updateEmployeeField(field, value);
    await reloadEmployees();
  };

  return (
    <ProviderAvailabilityContext.Provider value={availableProviders}>
    <div className="app-root">
      <TitleBar
        center={
          <GlobalSearch
            companyId={companyId}
            onSelectConversation={handleSelectConversation}
            onSelectMessage={handleSelectMessage}
            focusRef={searchFocusRef}
          />
        }
      >
        {company.name}
      </TitleBar>
      {startupError && <div className="startup-error-banner">{startupError}</div>}
      {update.available && (
        <div className="update-banner">
          <span className="update-banner-text">
            {update.installing
              ? "Installing update, restarting shortly…"
              : `A new version${update.version ? ` (${update.version})` : ""} is available.`}
          </span>
          {!update.installing && (
            <>
              <button className="update-banner-btn update-banner-btn-primary" onClick={update.install}>
                Restart to update
              </button>
              <button className="update-banner-btn update-banner-btn-dismiss" onClick={update.dismiss}>
                Dismiss
              </button>
            </>
          )}
        </div>
      )}
      <div className="app-shell">
      <IconRail
        view={view}
        onSelectView={setView}
        header={
          <CompanySwitcher
            current={company}
            companies={companies}
            onSwitch={handleSwitchCompany}
            onCreate={createCompany}
            onClone={handleCloneCompany}
            onOpenSettings={() => setAppSettingsOpen(true)}
          />
        }
      />

      {view === "home" && (
        <HomeView
          notificationsEnabled={notificationPrefLoaded ? notificationsEnabled : null}
          onToggleNotifications={setNotificationsEnabled}
          companyId={companyId}
          employeesById={employeesById}
        />
      )}

      {view === "projects" && <ProjectsView companyId={companyId} />}

      {view === "tasks" && <TasksView companyId={companyId} employeesById={employeesById} />}

      {view === "orgchart" && (
        <OrgChartView
          employees={employees}
          employeesById={employeesById}
          userFullName={userFullName}
          onSelectEmployee={(conversationId) => {
            setActiveId(conversationId);
            setView("chats");
          }}
        />
      )}

      {view === "chats" && (
        <>
          <Sidebar
            channels={channels}
            dms={visibleDms}
            activeId={activeId}
            onSelect={setActiveId}
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            onOpenSettings={(id) => {
              setActiveId(id);
              setSettingsOpen(true);
              setSidebarOpen(false);
            }}
            onOpenAppSettings={() => setAppSettingsOpen(true)}
            onOpenSearch={() => searchFocusRef.current?.()}
            onOpenGroup={() => setGroupOpen(true)}
            onOpenHire={() => setHireOpen(true)}
            onCreateChannel={handleCreateChannel}
            workspaceName={company.name}
            avatarByConversationId={avatarByConversationId}
            dmMeta={dmMeta}
          />
          {active && (
            // key by conversation id so switching conversations REMOUNTS ChatPane
            // with fresh per-conversation hook state. Without it the same
            // useConversation/useChannel instance is reused across switches, and an
            // in-flight streaming turn's finally-reload() (plus sending/reactions/
            // activeTools) commits the previous conversation's data into the newly
            // selected one (report T1.3).
            <ChatPane
              key={active.id}
              conversation={active}
              employee={employee}
              employees={employees}
              channels={channels}
              companyId={company.id}
              employeesById={employeesById}
              onNavigate={setActiveId}
              onOpenSidebar={() => setSidebarOpen(true)}
              onActivity={reloadActivity}
              focusTarget={searchFocus && active.id === searchFocus.conversationId ? searchFocus : null}
              onFocusHandled={() => setSearchFocus(null)}
            />
          )}
        </>
      )}
      {settingsOpen && active && employee && (
        <EmployeeSettingsPanel
          conversation={active}
          employee={employee}
          channels={channels}
          employees={employees}
          employeesById={employeesById}
          companyId={companyId ?? ""}
          companyProfile={company.profile}
          companySystemPrompt={company.system_prompt}
          userFullName={userFullName}
          onRename={async (name) => {
            await rename(active.id, name);
            await reloadEmployee();
          }}
          onUpdateField={handleUpdateEmployeeField}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {appSettingsOpen && (
        <AppSettingsModal
          company={company}
          onUpdateField={updateCompanyField}
          canDelete={companies.length > 1}
          onDelete={handleDeleteCompany}
          onClose={() => setAppSettingsOpen(false)}
          update={update}
        />
      )}
      {hireOpen && (
        <HireModal
          companyId={companyId}
          employees={employees}
          onCreated={async (conversationId) => {
            await reloadConversations();
            await reloadEmployees();
            setActiveId(conversationId);
            setSettingsOpen(true);
            setHireOpen(false);
          }}
          onClose={() => setHireOpen(false)}
        />
      )}
      {groupOpen && (
        <GroupModal
          employees={employees}
          employeesById={employeesById}
          onCreate={async (name, employeeIds) => {
            const conversationId = await createGroup(name, employeeIds);
            await reloadConversations();
            setActiveId(conversationId);
          }}
          onClose={() => setGroupOpen(false)}
        />
      )}
      </div>
    </div>
    </ProviderAvailabilityContext.Provider>
  );
}
