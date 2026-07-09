import { X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { command, query } from "../lib/runtimeClient";
import { Employee } from "../types";
import { EmployeeInfo } from "./MessageList";
import { PersonPickerRow } from "./PersonPicker";

interface Props {
  conversationId: string;
  channelName: string;
  employees: Employee[];
  employeesById: Record<string, EmployeeInfo>;
  onClose: () => void;
}

export function ChannelMembersModal({ conversationId, channelName, employees, employeesById, onClose }: Props) {
  // Previously each row ran its own useChannelMembership(employee.id) instance — N
  // employees meant N independent "am I a member" queries on open, and toggling one
  // did a full reload scoped to that one employee only. Query the channel's member
  // list ONCE instead and derive membership locally (report §1.7).
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const members = await query<Employee[]>("channel.members", { conversationId }, null);
      setMemberIds(new Set(members.map((m) => m.id)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load members.");
    } finally {
      setLoaded(true);
    }
  }, [conversationId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggle = useCallback(
    async (employeeId: string) => {
      // Optimistically flip so the checkbox responds immediately, then reconcile
      // with the server; on failure revert and surface the error.
      setMemberIds((prev) => {
        const next = new Set(prev);
        if (next.has(employeeId)) next.delete(employeeId);
        else next.add(employeeId);
        return next;
      });
      try {
        await command("membership.toggle", { conversationId, employeeId }, null);
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't update membership.");
        await reload();
      }
    },
    [conversationId, reload],
  );

  useEscapeToClose(true, onClose);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal channel-members-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>#{channelName} members</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="channel-members-list">
          {employees.length === 0 && <div className="hire-loading">No employees yet — hire someone first.</div>}
          {loaded &&
            employees.map((e) => (
              <PersonPickerRow
                key={e.id}
                name={employeesById[e.id]?.name ?? "Employee"}
                avatar={employeesById[e.id]?.avatar}
                meta={e.job_title || undefined}
                checked={memberIds.has(e.id)}
                onToggle={() => toggle(e.id)}
              />
            ))}
          {error && <p className="form-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
