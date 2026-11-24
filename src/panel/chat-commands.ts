export const chatCommands = ['/compact', '/new'] as const;
export type ChatCommand = typeof chatCommands[number];

export function matchChatCommands(draft: string): ChatCommand[] {
  if (!/^\/[a-z]*$/i.test(draft)) return [];
  return chatCommands.filter(command => command.startsWith(draft.toLowerCase()));
}
