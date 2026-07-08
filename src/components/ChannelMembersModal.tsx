import { X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { command, query } from "../lib/runtimeClient";
import { Employee } from "../types";
import { Avatar } from "./Avatar";
import { EmployeeInfo } from "./MessageList";

interface RowProps {
  employee: Employee;
  info: EmployeeInfo | undefined;
  checked: boolean;
  onToggle: () => void;
}

function MemberRow({ employee, info, checked, onToggle }: RowProps) {
  return (
    <label className="channel-member-row">
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <Avatar name={info?.name ?? "Employee"} avatar={info?.avatar} bot className="channel-member-avatar" />
      <span className="channel-member-name">{info?.name ?? "Employee"}</span>
      {employee.job_title && <span className="channel-member-title">{employee.job_title}</span>}
    </label>
  );
}

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

  const reload = useCallback(async () => {
    const members = await query<Employee[]>("channel.members", { conversationId }, null);
    setMemberIds(new Set(members.map((m) => m.id)));
    setLoaded(true);
  }, [conversationId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggle = useCallback(
    async (employeeId: string) => {
      await command("membership.toggle", { conversationId, employeeId }, null);
      await reload();
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
              <MemberRow
                key={e.id}
                employee={e}
                info={employeesById[e.id]}
                checked={memberIds.has(e.id)}
                onToggle={() => toggle(e.id)}
              />
            ))}
        </div>
      </div>
    </div>
  );
}
