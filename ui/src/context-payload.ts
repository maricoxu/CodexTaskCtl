import type {ContentBlock} from "@modelcontextprotocol/sdk/types.js";
type D = Record<string, any>;
/** Explicit selection only; attach binary images as image blocks, never just filenames. */
export async function reminderContext(items: D[], detail: (id: number) => Promise<D>,
  read: (uri: string) => Promise<{contents: any[]}>) {
  const content: ContentBlock[] = [];
  let imageCount = 0;
  let imageBytes = 0;
  for (const selected of items) {
    const item = await detail(selected.id);
    content.push({type: "text", text: JSON.stringify({
      id: item.id, title: item.title, notes: item.notes || "", list: item.list,
      resourceUri: item.resourceUri, url: item.url, dueDate: item.dueDate,
    }), _meta: {"openai/title": item.title, "remctl/id": item.id}});
    for (const attachment of item.attachments || []) {
      if (attachment.type !== "image") continue;
      if (++imageCount > 8) throw new Error("Select at most 8 images for one conversation context.");
      if (!attachment.resourceUri || attachment.resolved === false)
        throw new Error("An image is not downloaded. Open it in Reminders and try again.");
      const result = await read(attachment.resourceUri);
      const resource = result.contents.find(c => typeof c.blob === "string" && c.mimeType?.startsWith("image/"));
      if (!resource) throw new Error("Image content could not be read.");
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(resource.mimeType))
        throw new Error("Convert HEIC to PNG or JPEG before sharing it with a conversation.");
      imageBytes += resource.blob.length * 3 / 4;
      if (imageBytes > 16 * 1024 * 1024) throw new Error("Selected image context exceeds 16 MiB.");
      content.push({type: "image", mimeType: resource.mimeType, data: resource.blob,
        _meta: {"openai/title": attachment.filename || "Reminder image", "remctl/id": item.id}});
    }
  }
  return content;
}

