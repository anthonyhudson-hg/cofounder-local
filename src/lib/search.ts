/** Frontend mirror of the sidecar's globalSearch result shape (kept in sync by hand). */

export interface SearchChannelHit {
  conversationId: string;
  name: string;
  isGroup: boolean;
}

export interface SearchPersonHit {
  conversationId: string;
  employeeId: string;
  name: string;
  jobTitle: string;
  department: string;
  avatar: string | null;
}

export interface SearchMessageHit {
  messageId: string;
  conversationId: string;
  conversationName: string;
  conversationKind: "dm" | "channel";
  isGroup: boolean;
  threadRootId: string | null;
  authorName: string;
  snippet: string;
  createdAt: string;
}

export interface GlobalSearchResults {
  channels: SearchChannelHit[];
  people: SearchPersonHit[];
  messages: SearchMessageHit[];
}

export const EMPTY_SEARCH_RESULTS: GlobalSearchResults = { channels: [], people: [], messages: [] };

export function totalHits(r: GlobalSearchResults): number {
  return r.channels.length + r.people.length + r.messages.length;
}

/** Where a search-result message lives, for jump-to navigation. */
export interface MessageTarget {
  conversationId: string;
  messageId: string;
  threadRootId: string | null;
}
