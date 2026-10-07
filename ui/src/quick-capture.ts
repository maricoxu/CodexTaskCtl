export type CaptureImage = {id: string; name: string; mimeType: string; data: string; attached?: boolean};
export type CaptureState = {operationId: string; reminderId?: number; blocked?: string; images: CaptureImage[]};
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/heic"];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export function validateImage(file: {type: string; size: number}) {
  if (!IMAGE_TYPES.includes(file.type) || !file.size || file.size > MAX_IMAGE_BYTES)
    throw new Error("Choose PNG, JPEG, WebP or HEIC images up to 8 MiB.");
}
export async function readCaptureImage(file: File): Promise<CaptureImage> {
  validateImage(file);
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(new Error("The image could not be read."));
    r.readAsDataURL(file);
  });
  return {id: crypto.randomUUID(), name: file.name || "Pasted image", mimeType: file.type, data};
}
/** Checkpoint the created identity BEFORE attachments. Retries never recreate a reminder. */
export async function saveCapture(state: CaptureState, api: {
  create: (operationId: string) => Promise<any>;
  attach: (reminderId: number, image: CaptureImage) => Promise<any>;
  checkpoint: (state: CaptureState) => void;
}) {
  if (state.blocked) throw new Error(state.blocked);
  state = {...state, images: state.images.map(i => ({...i}))};
  if (!state.reminderId) {
    let result;
    try { result = await api.create(state.operationId); }
    catch (error) {
      state.blocked = "Creation was not confirmed. Check the reminder list before creating another.";
      api.checkpoint(state);
      throw error;
    }
    const validId = Number.isSafeInteger(result.id) && result.id > 0;
    if (validId) state.reminderId = result.id;
    // Without images a confirmed creation can succeed even if its local numeric ID is delayed.
    if (!validId && !(result.status === "created" && state.images.length === 0)) {
      state.blocked = "Creation needs attention. Check the reminder list; this draft will not create a duplicate.";
      api.checkpoint(state);
      throw new Error(state.blocked);
    }
    api.checkpoint(state);
  }
  for (const image of state.images) {
    if (image.attached) continue;
    try {
      const result = await api.attach(state.reminderId!, image);
      if (["partial", "uncertain", "error", "failed"].includes(result?.status))
        throw new Error(result.message || "Attachment outcome needs checking.");
      image.attached = true;
      api.checkpoint({...state, images: state.images.map(i => ({...i}))});
    } catch (error) {
      throw new Error("Reminder #" + state.reminderId + " exists. Images remain in the draft: " + (error as Error).message);
    }
  }
  return state;
}

