import { useEffect, useState } from "react";
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
import { OrgChartView } from "./components/OrgChartView";
import { SearchModal } from "./components/SearchModal";
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
import { useStartupErrors } from "./hooks/useStartupErrors";
import { useUpdateChecker } from "./hooks/useUpdateChecker";
import { useUserProfile } from "./hooks/useUserProfile";
import { setActiveCompanyId } from "./lib/activeCompany";
import { command } from "./lib/runtimeClient";
import { applyTheme, themeForColor } from "./lib/themes";
import { Employee } from "./types";

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
  const [searchOpen, setSearchOpen] = useState(false);
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
  useDesktopNotifications(notificationsEnabled, activeId);
  const startupError = useStartupErrors();
  const update = useUpdateChecker();

  // Apply the active company's theme across the whole UI; re-applies on switch.
  useEffect(() => {
    applyTheme(themeForColor(company?.color));
  }, [company?.color]);

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

  if (!companyLoaded || !loaded || !profileLoaded) {
    return (
      <div className="app-root">
        <TitleBar />
        {startupError && <div className="startup-error-banner">{startupError}</div>}
        <div className="app-loading">Loading...</div>
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

  const searchEntries = employees
    .map((emp) => {
      const conversation = allConversations.find((c) => c.id === emp.conversation_id);
      return conversation ? { employee: emp, conversation } : null;
    })
    .filter((x): x is { employee: Employee; conversation: (typeof dms)[number] } => x !== null);

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
    <div className="app-root">
      <TitleBar>{company.name}</TitleBar>
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
            onOpenSearch={() => setSearchOpen(true)}
            onOpenGroup={() => setGroupOpen(true)}
            onOpenHire={() => setHireOpen(true)}
            onCreateChannel={handleCreateChannel}
            workspaceName={company.name}
            avatarByConversationId={avatarByConversationId}
            dmMeta={dmMeta}
          />
          {active && (
            <ChatPane
              conversation={active}
              employee={employee}
              employees={employees}
              channels={channels}
              companyId={company.id}
              employeesById={employeesById}
              onNavigate={setActiveId}
              onOpenSidebar={() => setSidebarOpen(true)}
              onActivity={reloadActivity}
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
      {searchOpen && (
        <SearchModal
          entries={searchEntries}
          onSelect={(conversationId) => setActiveId(conversationId)}
          onClose={() => setSearchOpen(false)}
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
  );
}
