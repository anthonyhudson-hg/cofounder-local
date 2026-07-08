import { X } from "@phosphor-icons/react";
import { useChannelMembership } from "../hooks/useChannelMembership";
import { Employee } from "../types";
import { Avatar } from "./Avatar";
import { EmployeeInfo } from "./MessageList";

interface RowProps {
  employee: Employee;
  conversationId: string;
  info: EmployeeInfo | undefined;
}

function MemberRow({ employee, conversationId, info }: RowProps) {
  const { memberOf, toggle } = useChannelMembership(employee.id);

  return (
    <label className="channel-member-row">
      <input
        type="checkbox"
        checked={memberOf.has(conversationId)}
        onChange={() => toggle(conversationId)}
      />
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
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal channel-members-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>#{channelName} members</h3>
          <button className="modal-close" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="channel-members-list">
          {employees.length === 0 && <div className="hire-loading">No employees yet — hire someone first.</div>}
          {employees.map((e) => (
            <MemberRow key={e.id} employee={e} conversationId={conversationId} info={employeesById[e.id]} />
          ))}
        </div>
      </div>
    </div>
  );
}
