import { BellSimple, BellSimpleSlash } from "@phosphor-icons/react";
import { ActivityView } from "./ActivityView";
import { ApprovalsPanel } from "./ApprovalsPanel";
import { EmployeeInfo } from "./MessageList";

interface Props {
  notificationsEnabled: boolean | null;
  onToggleNotifications: (enabled: boolean) => void;
  companyId: string | null;
  employeesById: Record<string, EmployeeInfo>;
}

export function HomeView({ notificationsEnabled, onToggleNotifications, companyId, employeesById }: Props) {
  return (
    <div className="home-view">
      <div className="home-view-inner">
        <h2 className="home-view-title">Preferences</h2>

        <div className="home-pref-row">
          <div className="home-pref-text">
            {notificationsEnabled ? <BellSimple size={20} /> : <BellSimpleSlash size={20} />}
            <div>
              <div className="home-pref-label">Desktop notifications</div>
              <div className="home-pref-hint">
                Get notified when an employee replies — across every company, even ones you're not currently
                viewing.
              </div>
            </div>
          </div>
          <button
            className={`home-pref-toggle ${notificationsEnabled ? "on" : ""}`}
            disabled={notificationsEnabled === null}
            onClick={() => onToggleNotifications(!notificationsEnabled)}
            role="switch"
            aria-checked={!!notificationsEnabled}
            aria-label="Desktop notifications"
          >
            <span className="home-pref-toggle-knob" />
          </button>
        </div>

        <ApprovalsPanel companyId={companyId} employeesById={employeesById} />
        <ActivityView companyId={companyId} />
      </div>
    </div>
  );
}
