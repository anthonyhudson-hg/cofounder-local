import { readImageAsResizedDataUrl } from "../lib/avatar";
import { AsyncActionState, useAsyncAction } from "./useAsyncAction";

/**
 * Shared resize-and-upload flow for company/employee icon uploads. Extracted because
 * AppSettingsModal and EmployeeSettingsPanel each had a byte-for-byte copy of this
 * function, including the same missing-error-handling bug (report §1.7).
 */
export function usePhotoUpload(
  onUploaded: (dataUrl: string) => void,
): [(file: File) => Promise<void | undefined>, AsyncActionState] {
  const [run, state] = useAsyncAction(async (file: File) => {
    const dataUrl = await readImageAsResizedDataUrl(file);
    onUploaded(dataUrl);
  });
  return [run, state];
}
