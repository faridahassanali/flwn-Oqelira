import type { IconName } from './icons.js'

/** Primary sections are the everyday places; secondary ones live in a second, always visible group. */
export function navGroups(server: boolean): { primary: IconName[]; secondary: IconName[] } {
  return server
    ? { primary: ['Chat', 'Projects', 'Explorer', 'Git'], secondary: ['Tasks', 'Terminal', 'Memory', 'Teams', 'Connections', 'Settings'] }
    : { primary: ['Chat', 'Explorer', 'Git'], secondary: ['Tasks', 'Terminal', 'Settings'] }
}

export const navLabel = (name: string) => (name === 'Explorer' ? 'Files' : name)
