import { useMemo } from "react";
import { Employee } from "../types";
import { Avatar } from "./Avatar";
import { EmployeeInfo } from "./MessageList";

interface Props {
  employees: Employee[];
  employeesById: Record<string, EmployeeInfo>;
  userFullName: string;
  onSelectEmployee: (conversationId: string) => void;
}

interface TreeNode {
  employee: Employee | null;
  name: string;
  children: TreeNode[];
}

function buildTree(employees: Employee[], userFullName: string): TreeNode {
  const childrenOf = new Map<string | null, Employee[]>();
  const visited = new Set<string>();

  for (const e of employees) {
    const key = e.manager_employee_id;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(e);
  }

  const toNode = (e: Employee): TreeNode | null => {
    if (visited.has(e.id)) return null; // guard against accidental cycles
    visited.add(e.id);
    const kids = (childrenOf.get(e.id) ?? []).map(toNode).filter((n): n is TreeNode => n !== null);
    return { employee: e, name: "", children: kids };
  };

  const roots = (childrenOf.get(null) ?? []).map(toNode).filter((n): n is TreeNode => n !== null);
  return { employee: null, name: userFullName || "You", children: roots };
}

function OrgNode({
  node,
  employeesById,
  onSelectEmployee,
  isRoot,
}: {
  node: TreeNode;
  employeesById: Record<string, EmployeeInfo>;
  onSelectEmployee: (conversationId: string) => void;
  isRoot: boolean;
}) {
  const info = node.employee ? employeesById[node.employee.id] : undefined;
  const displayName = node.employee ? info?.name ?? "Employee" : node.name;

  return (
    <li className="org-chart-node">
      <button
        className={`org-chart-card ${isRoot ? "org-chart-card-root" : ""}`}
        onClick={() => node.employee && onSelectEmployee(node.employee.conversation_id)}
        disabled={!node.employee}
      >
        <Avatar name={displayName} avatar={info?.avatar ?? null} bot={!isRoot} className="org-chart-avatar" />
        <span className="org-chart-name">{displayName}</span>
        {node.employee && (
          <span className="org-chart-title">
            {node.employee.job_title}
            {node.employee.department ? ` · ${node.employee.department}` : ""}
          </span>
        )}
        {isRoot && <span className="org-chart-title">Founder</span>}
      </button>

      {node.children.length > 0 && (
        <ul className="org-chart-children">
          {node.children.map((child) => (
            <OrgNode
              key={child.employee?.id ?? "root"}
              node={child}
              employeesById={employeesById}
              onSelectEmployee={onSelectEmployee}
              isRoot={false}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrgChartView({ employees, employeesById, userFullName, onSelectEmployee }: Props) {
  const tree = useMemo(() => buildTree(employees, userFullName), [employees, userFullName]);

  return (
    <div className="org-chart-view">
      <header className="org-chart-header">
        <h2>Org chart</h2>
        <p className="org-chart-subtitle">
          {employees.length} {employees.length === 1 ? "employee" : "employees"} reporting up through you.
        </p>
      </header>
      <div className="org-chart-scroll">
        <ul className="org-chart-tree">
          <OrgNode node={tree} employeesById={employeesById} onSelectEmployee={onSelectEmployee} isRoot />
        </ul>
      </div>
    </div>
  );
}
