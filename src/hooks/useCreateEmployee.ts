import { useCallback } from "react";
import { command } from "../lib/runtimeClient";
import { urlToResizedDataUrl } from "../lib/avatar";

export interface NewEmployeeParams {
  name: string;
  photoUrl?: string;
  jobTitle?: string;
  department?: string;
  // Full-persona fields — populated when hiring a generated candidate.
  mission?: string;
  preamble?: string;
  additionalDetails?: string;
  responsibilities?: string[];
  personality?: string;
  communicationStyle?: string;
  expertise?: string[];
}

export function useCreateEmployee(companyId: string | null) {
  const create = useCallback(
    async (params: NewEmployeeParams) => {
      if (!companyId) throw new Error("No active company");

      let avatar: string | null = null;
      if (params.photoUrl) {
        try {
          avatar = await urlToResizedDataUrl(params.photoUrl);
        } catch (err) {
          console.error("Failed to fetch candidate photo, continuing without an avatar:", err);
          avatar = null;
        }
      }

      return command<{ conversationId: string; employeeId: string }>(
        "employee.create",
        {
          name: params.name,
          jobTitle: params.jobTitle ?? "",
          department: params.department ?? "",
          avatar,
          mission: params.mission,
          preamble: params.preamble,
          additionalDetails: params.additionalDetails,
          responsibilities: params.responsibilities,
          personality: params.personality,
          communicationStyle: params.communicationStyle,
          expertise: params.expertise,
        },
        companyId,
      );
    },
    [companyId],
  );

  return { create };
}
